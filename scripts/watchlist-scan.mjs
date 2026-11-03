#!/usr/bin/env node
/**
 * watchlist-scan.mjs — compact multi-TF scanner for the TradingView watchlist.
 *
 * Walks every watchlist symbol (plus fixed market-context symbols) on W / D / 4H,
 * computes EMA20/50/200, RSI14, ATR14, relative volume, anchored VWAPs and a
 * volume-profile POC and Binance perp open interest from raw bars, and keeps only the useful bits of the chart's
 * Pine indicators (MicaTradeGPT signals/table, SMC structure near price).
 *
 * Output: scan-output/digest.txt — one dense line per symbol/TF, small enough for
 * Claude to analyse inline without subagents (~10-20k tokens for ~40 symbols).
 *
 * Usage:
 *   node scripts/watchlist-scan.mjs                 # whole watchlist
 *   node scripts/watchlist-scan.mjs BINANCE:BTCUSDT,BINANCE:SOLUSDT
 *   TFS=D,240 node scripts/watchlist-scan.mjs       # override timeframes
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chart, data, watchlist } from '../src/core/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'scan-output');
const CONTEXT = ['BINANCE:BTCUSDT', 'CRYPTOCAP:USDT.D', 'CRYPTOCAP:BTC.D', 'CRYPTOCAP:TOTAL3'];
const TFS = (process.env.TFS || 'W,D,240').split(',');
const SETTLE_MS = Number(process.env.SETTLE_MS || 4000); // let heavy Pine scripts finish
const NEAR = 0.12; // keep structure levels within ±12% of price

const sleep = ms => new Promise(r => setTimeout(r, ms));
const safe = async fn => { try { return await fn(); } catch { return null; } };

// ---------- maths on bars ----------
const ema = (xs, n) => {
  if (xs.length < n) return null;
  const k = 2 / (n + 1);
  let e = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < xs.length; i++) e = xs[i] * k + e * (1 - k);
  return e;
};
const rsi = (xs, n = 14) => {
  if (xs.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = xs[i] - xs[i - 1]; d > 0 ? (g += d) : (l -= d); }
  g /= n; l /= n;
  for (let i = n + 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
};
const atr = (b, n = 14) => {
  if (b.length <= n) return null;
  const tr = b.slice(1).map((x, i) => Math.max(x.high - x.low, Math.abs(x.high - b[i].close), Math.abs(x.low - b[i].close)));
  let a = tr.slice(0, n).reduce((s, v) => s + v, 0) / n;
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
};
const vwapFrom = (b, i0) => {
  let pv = 0, v = 0;
  for (let i = i0; i < b.length; i++) { const tp = (b[i].high + b[i].low + b[i].close) / 3; pv += tp * b[i].volume; v += b[i].volume; }
  return v ? pv / v : null;
};
const poc = (b, bins = 40) => {
  const lo = Math.min(...b.map(x => x.low)), hi = Math.max(...b.map(x => x.high));
  if (!(hi > lo)) return null;
  const step = (hi - lo) / bins, vol = new Array(bins).fill(0);
  for (const x of b) {
    const a = Math.floor((x.low - lo) / step), z = Math.min(bins - 1, Math.floor((x.high - lo) / step));
    const span = z - a + 1;
    for (let i = a; i <= z; i++) vol[i] += x.volume / span;
  }
  const i = vol.indexOf(Math.max(...vol));
  return lo + step * (i + 0.5);
};

// ---------- formatting ----------
const sig = n => (n == null || !isFinite(n) ? '-' : Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : Math.abs(n) >= 1000 ? n.toFixed(0) : Math.abs(n) >= 1 ? +n.toPrecision(5) + '' : +n.toPrecision(4) + '');
const pct = (a, b) => (a && b ? ((a / b - 1) * 100).toFixed(1) + '%' : '-');

function pineBits(studies, tables, labels, boxes, price) {
  const out = [];
  for (const s of studies?.studies || []) {
    if (/MicaTradeGPT/.test(s.name)) {
      const active = Object.entries(s.values).filter(([, v]) => parseFloat(String(v).replace(',', '.')) !== 0).map(([k]) => k);
      if (active.length) out.push(`${s.name.replace('MicaTradeGPT ', 'Mica')}:${active.join('+')}`);
    }
  }
  for (const s of tables?.studies || []) {
    if (!/MicaTradeGPT/.test(s.name)) continue;
    const rows = (s.tables || []).flatMap(t => t.rows);
    const pick = rows.filter(r => /^(Div Bull|Div Bear|WT2|HTF|LB sweep)/.test(r)).map(r => r.replace(/\s*\|\s*/, '=')).filter(r => !/=---$/.test(r));
    if (pick.length) out.push('MicaTbl[' + pick.join(', ') + ']');
  }
  const near = p => p && Math.abs(p / price - 1) <= NEAR;
  for (const s of labels?.studies || []) {
    if (!/Smart Money/.test(s.name)) continue;
    const seen = new Set();
    const lv = s.labels.filter(l => near(l.price) && l.text.trim())
      .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
      .filter(l => { const k = l.text + sig(l.price); return !seen.has(k) && seen.add(k); })
      .slice(0, 10).sort((a, b) => b.price - a.price)
      .map(l => `${l.text.trim()}@${sig(l.price)}`);
    if (lv.length) out.push('SMC[' + lv.join(' ') + ']');
  }
  for (const s of boxes?.studies || []) {
    const z = s.zones.filter(b => near((b.high + b.low) / 2))
      .sort((a, b) => Math.abs((a.high + a.low) / 2 - price) - Math.abs((b.high + b.low) / 2 - price))
      .slice(0, 5).map(b => `${sig(b.low)}-${sig(b.high)}`);
    if (z.length) out.push(`Zones(${s.name.split(' ')[0]})[${z.join(' ')}]`);
  }
  return out.join(' ');
}

async function scanTf(symbol, tf) {
  await safe(() => chart.setTimeframe({ timeframe: tf }));
  await safe(() => chart.setSymbol({ symbol }));
  await sleep(SETTLE_MS);
  const res = await safe(() => data.getOhlcv({ count: 300 }));
  const b = res?.bars || [];
  if (b.length < 20) return `${tf}: no data`;
  const c = b.map(x => x.close), price = c[c.length - 1];
  const last50 = b.slice(-50), last200 = b.slice(-200);
  const hiIdx = b.length - last200.length + last200.reduce((m, x, i, a) => (x.high > a[m].high ? i : m), 0);
  const loIdx = b.length - last200.length + last200.reduce((m, x, i, a) => (x.low < a[m].low ? i : m), 0);
  const avgVol = b.slice(-21, -1).reduce((s, x) => s + x.volume, 0) / 20;
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200), a = atr(b);
  const swingHi = Math.max(...last50.map(x => x.high)), swingLo = Math.min(...last50.map(x => x.low));

  const [studies, tables, labels, boxes] = [
    await safe(() => data.getStudyValues()),
    await safe(() => data.getPineTables({ study_filter: 'MicaTradeGPT' })),
    await safe(() => data.getPineLabels({ study_filter: 'Smart Money', max_labels: 80 })),
    await safe(() => data.getPineBoxes({ study_filter: 'Smart Money' })),
  ];

  const trend = e20 && e50 ? (price > e20 && e20 > e50 ? 'UP' : price < e20 && e20 < e50 ? 'DOWN' : 'MIX') : '?';
  return [
    `${tf}: px=${sig(price)} trend=${trend}`,
    `ema20=${sig(e20)}(${pct(price, e20)}) ema50=${sig(e50)}(${pct(price, e50)}) ema200=${sig(e200)}(${pct(price, e200)})`,
    `rsi=${sig(rsi(c))} atr=${sig(a)}(${a ? ((a / price) * 100).toFixed(1) : '-'}%) relVol=${avgVol ? (b[b.length - 1].volume / avgVol).toFixed(2) : '-'}`,
    `rng50=${sig(swingLo)}-${sig(swingHi)} avwapHi=${sig(vwapFrom(b, hiIdx))} avwapLo=${sig(vwapFrom(b, loIdx))} poc200=${sig(poc(last200))}`,
    pineBits(studies, tables, labels, boxes, price),
  ].filter(Boolean).join(' | ');
}

// Open interest comes from Binance perp data symbols, so it needs no indicator slot.
// A symbol that never loads must not stall the scan, so every step is time limited.
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => null)]);

async function scanOi(symbol) {
  const m = symbol.match(/:([A-Z0-9]+?)USDT(.P)?$/);
  if (!m) return null;
  const oiSymbol = `BINANCE:${m[1]}USDT.P_OI`;
  await safe(() => chart.setTimeframe({ timeframe: "D" }));
  await withTimeout(safe(() => chart.setSymbol({ symbol: oiSymbol })), 10000);
  await sleep(2500);
  const state = await withTimeout(safe(() => chart.getState()), 5000);
  if (state?.symbol !== oiSymbol) return "OI: no data";
  const res = await withTimeout(safe(() => data.getOhlcv({ count: 30 })), 8000);
  const c = (res?.bars || []).map(b => b.close);
  if (c.length < 8) return "OI: no data";
  const last = c[c.length - 1];
  return `OI: ${sig(last)} 1d=${pct(last, c[c.length - 2])} 7d=${pct(last, c[c.length - 8])}`;
}

// ---------- main ----------
const argSyms = process.argv[2]?.split(',').filter(Boolean);
let symbols = argSyms;
if (!symbols) {
  const w = await watchlist.get();
  symbols = w.symbols.map(s => s.symbol);
  if (!symbols.length) { console.error('Watchlist empty/unreadable — pass symbols as an argument.'); process.exit(1); }
}
const all = [...CONTEXT, ...symbols.filter(s => !CONTEXT.includes(s))];
mkdirSync(OUT_DIR, { recursive: true });

const startState = await safe(() => chart.getState());
const lines = [`# scan ${new Date().toISOString()} | TFs ${TFS.join(',')} | context: ${CONTEXT.join(', ')}`];
for (const [i, sym] of all.entries()) {
  const parts = [];
  for (const tf of TFS) {
    try { parts.push(await scanTf(sym, tf)); } catch (e) { parts.push(`${tf}: error ${e.message}`); }
  }
  const oi = await scanOi(sym);
  if (oi) parts.push(oi);
  lines.push(`## ${sym}${CONTEXT.includes(sym) ? ' [CONTEXT]' : ''}\n` + parts.map(p => '  ' + p).join('\n'));
  console.error(`[${i + 1}/${all.length}] ${sym}`);
  writeFileSync(join(OUT_DIR, 'digest.txt'), lines.join('\n') + '\n'); // incremental save
}
if (startState?.symbol) { await safe(() => chart.setSymbol({ symbol: startState.symbol })); await safe(() => chart.setTimeframe({ timeframe: startState.resolution })); }
console.error(`done → ${join(OUT_DIR, 'digest.txt')}`);
process.exit(0);
