/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

/** Format a price the way the dialog expects, using the decimal separator of its prefilled value. */
export function formatPrice(price, sample = '') {
  const plain = Number(price).toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  return sample.includes(',') ? plain.replace('.', ',') : plain;
}

/** Parse a dialog value such as "3,25", "76.550,00" or "76,550.00". */
export function parsePrice(text) {
  const s = String(text).trim();
  const dec = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  const hasBoth = s.includes(',') && s.includes('.');
  if (!hasBoth && s.includes('.') && s.split('.').length > 2) return parseFloat(s.replace(/\./g, ''));
  if (!hasBoth && s.includes(',') && s.split(',').length > 2) return parseFloat(s.replace(/,/g, ''));
  if (dec < 0) return parseFloat(s);
  return parseFloat(s.slice(0, dec).replace(/[.,]/g, '') + '.' + s.slice(dec + 1));
}

const samePrice = (a, b) => Math.abs(a - b) <= Math.abs(b) * 1e-6;

/**
 * Create a "crossing" price alert on the chart's current symbol through the Alt+A dialog.
 * Selectors are structural, not text based, so this works in any UI language.
 * Reports success only after the alert shows up as active in the alerts API.
 */
export async function create({ condition, price, message }) {
  if (condition && !/cross/i.test(condition)) {
    throw new Error(`Unsupported alert condition "${condition}": only crossing alerts can be created`);
  }
  const client = await getClient();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const cancel = () => evaluate(`
    (function() {
      var submit = document.querySelector('form button[type="submit"]');
      var btn = submit && submit.parentElement.querySelector('button[type="button"]');
      if (btn) btn.click();
    })()
  `);

  await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 1, key: 'a', code: 'KeyA' });
  await sleep(1500);

  const prefilled = await evaluate(`
    (function() {
      var a = document.activeElement;
      if (!a || a.tagName !== 'INPUT' || !a.closest('form')) return null;
      a.setAttribute('data-mcp-alert-price', '1');
      a.select();
      return a.value;
    })()
  `);
  if (prefilled == null) throw new Error('Alert dialog did not open with its price field focused');

  await client.Input.insertText({ text: formatPrice(price, prefilled) });
  await sleep(300);
  await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Tab', code: 'Tab' });
  await sleep(500);

  const typed = await evaluate(`document.querySelector('[data-mcp-alert-price]')?.value`);
  if (!samePrice(parsePrice(typed), price)) {
    await cancel();
    throw new Error(`Alert price field shows "${typed}" instead of ${price}; alert not created`);
  }

  const submitted = await evaluate(`
    (function() {
      var input = document.querySelector('[data-mcp-alert-price]');
      var btn = input && input.closest('form').querySelector('button[type="submit"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  if (!submitted) {
    await cancel();
    throw new Error('Alert submit button not found');
  }
  await sleep(1500);

  const symbol = await evaluate(`window.TradingViewApi._activeChartWidgetWV.value().symbol()`);
  const { alerts } = await list();
  const created = alerts.find(a => a.active && a.symbol === symbol
    && samePrice(a.condition?.series?.[1]?.value ?? NaN, price));
  if (!created) {
    await cancel();
    throw new Error(`Alert for ${symbol} at ${price} was not found after submitting`);
  }

  return {
    success: true, symbol, price, condition: 'crossing', alert_id: created.alert_id,
    expiration: created.expiration, message: created.message,
    ...(message ? { message_applied: false, note: 'Custom messages are not supported; the default message was used.' } : {}),
  };
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

export async function deleteAlerts({ delete_all }) {
  if (delete_all) {
    const result = await evaluate(`
      (function() {
        var alertBtn = document.querySelector('[data-name="alerts"]');
        if (alertBtn) alertBtn.click();
        var header = document.querySelector('[data-name="alerts"]');
        if (header) {
          header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
          return { context_menu_opened: true };
        }
        return { context_menu_opened: false };
      })()
    `);
    return { success: true, note: 'Alert deletion requires manual confirmation in the context menu.', context_menu_opened: result?.context_menu_opened || false, source: 'dom_fallback' };
  }
  throw new Error('Individual alert deletion not yet supported. Use delete_all: true.');
}
