// stocks.js — client-side penny-stock scanner (mirrors pump.js/data.js role).
// Polls the SAME-ORIGIN /api/stocks proxy (key never touches the browser).
// Fully independent from the crypto loop: own timer, own state, own errors.
import { CONFIG } from './config.js';
import { scoreStock } from './stockScoring.js';
import { loadSeen, markSeen } from './store.js';
import { requestPermissionOnLoad, notifyHighPotential } from './notify.js';

const tracked = new Map(); // symbol -> { quote, score, alerted }
const seen = loadSeen();   // shared localStorage bucket; keys are symbols vs mints so no clash
let pollTimer = null;
let scanning = false;

const $ = (id) => document.getElementById(id);

async function fetchMovers() {
  const url = `/api/stocks?action=movers&maxPrice=${CONFIG.STOCK_MAX_PRICE}&limit=${CONFIG.STOCK_MOVERS_LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`movers HTTP ${res.status}`);
  return res.json();
}

async function fetchQuote(symbol) {
  const res = await fetch(`/api/stocks?action=quote&symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`quote HTTP ${res.status} for ${symbol}`);
  return res.json();
}

function upsertRow(symbol, quote, scored) {
  const prev = tracked.get(symbol) || {};
  tracked.set(symbol, { ...prev, quote, scored, alerted: prev.alerted || false, notifStatus: prev.notifStatus || null });
}

function render() {
  const tbody = $('stockResults');
  if (!tbody) return;
  const rows = [...tracked.entries()]
    .sort((a, b) => (b[1].scored?.score ?? 0) - (a[1].scored?.score ?? 0))
    .map(([sym, s]) => {
      const q = s.quote || {};
      const sc = s.scored || {};
      const notifBadge = s.notifStatus === 'muted' ? ' (muted 🔕)'
        : s.notifStatus === 'no-permission' ? ' (no permission ⚠️)'
        : s.notifStatus === 'sent' ? ' 🔔' : '';
      return `<tr><td><b>${sym}</b></td>` +
        `<td>${q.price != null ? '$' + Number(q.price).toFixed(3) : '…'}</td>` +
        `<td>${q.changePct != null ? Number(q.changePct).toFixed(2) + '%' : '…'}</td>` +
        `<td>${q.volume != null ? Number(q.volume).toLocaleString() : (q.avgVolume != null ? 'avg ' + Number(q.avgVolume).toLocaleString() : '…')}</td>` +
        `<td>${sc.score ?? '…'}</td>` +
        `<td>${s.alerted ? 'alerted' + notifBadge : (sc.potential_label || '…')}</td></tr>`;
    });
  tbody.innerHTML = rows.join('') || `<tr><td colspan="6">No stocks yet — press Scan Now.</td></tr>`;
  const count = $('stockCount');
  if (count) count.textContent = String(tracked.size);
  const status = $('stockStatus');
  if (status && !scanning) status.textContent = `updated ${new Date().toLocaleTimeString()}`;
}

export async function scanStocksNow() {
  if (scanning) return;
  scanning = true;
  const status = $('stockStatus');
  try {
    if (status) status.textContent = 'scanning…';
    const data = await fetchMovers();
    for (const m of data.movers || []) {
      try {
        // Refresh per-symbol quote for current price/volume/day-change.
        const q = await fetchQuote(m.symbol);
        const relVol = q.avgVolume ? (q.volume || 0) / q.avgVolume : null;
        const scored = scoreStock({ changePct: q.changePct ?? 0, relVolume: relVol, price: q.price ?? 0 });
        upsertRow(m.symbol, q, scored);
        const st = tracked.get(m.symbol);
        if (scored.isHighPotential && (q.changePct ?? 0) >= CONFIG.STOCK_MIN_CHANGE_PCT
            && !st.alerted && !seen[m.symbol]) {
          st.alerted = true;
          markSeen(m.symbol, { ...scored, symbol: m.symbol });
          st.notifStatus = notifyHighPotential({ mint: m.symbol, score: scored.score, liquidity_usd: 0, potential_label: 'STOCK HIGH POTENTIAL' }, 'stock');
        }
      } catch (e) {
        console.warn('Stock quote failed for', m.symbol, e);
      }
    }
  } catch (e) {
    console.warn('Stock movers scan failed (crypto loop unaffected):', e);
    if (status) status.textContent = 'scan failed: ' + e.message;
  } finally {
    scanning = false;
    render();
  }
}

export function startStockMonitoring() {
  if (pollTimer) return;
  requestPermissionOnLoad();
  scanStocksNow();
  pollTimer = setInterval(() => { scanStocksNow().catch((e) => console.warn('stock poll', e)); }, CONFIG.STOCK_POLL_INTERVAL_SECONDS * 1000);
  $('stockStartBtn').disabled = true;
  $('stockStopBtn').disabled = false;
}

export function stopStockMonitoring() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if ($('stockStartBtn')) $('stockStartBtn').disabled = false;
  if ($('stockStopBtn')) $('stockStopBtn').disabled = true;
  if ($('stockStatus')) $('stockStatus').textContent = 'stopped';
}

// Expose for inline onclick handlers.
window.scanStocksNow = scanStocksNow;
window.startStockMonitoring = startStockMonitoring;
window.stopStockMonitoring = stopStockMonitoring;

render();
