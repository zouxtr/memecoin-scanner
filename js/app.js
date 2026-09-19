// app.js — client-side monitoring engine (port of main.py monitor loop).
// Tracks graduated coins, polls DexScreener/RugCheck per coin, scores
// with scoring.js, notifies via notify.js, persists via store.js.
import { CONFIG } from './config.js';
import { getDexscreenerPairs, getRugcheckReport, extractMintAddress } from './data.js';
import { scoreToken } from './scoring.js';
import { listenForMigrations } from './pump.js';
import { scoreRugRisk } from './rugSignals.js';
import { loadSeen, markSeen } from './store.js';
import { requestPermissionOnLoad, notifyHighPotential, isHighPotential } from './notify.js';

const tracked = new Map(); // mint -> { firstPrice, peakPrice, polls, consecutive, rugcheck, deadline, result }
const seen = loadSeen();
let pumpHandle = null;
let pollTimer = null;

const $ = (id) => document.getElementById(id);

function safeFloat(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

export async function scanCoin(mint, creator = null) {
  const [pairs, rugcheck] = await Promise.all([
    getDexscreenerPairs(mint),
    getRugcheckReport(mint),
  ]);
  const best = (pairs && pairs[0]) || {};
  // On-demand scan has no price history: momentum 0 (same as first poll).
  const result = scoreToken(mint, best, rugcheck, 0);
  const rug = scoreRugRisk({ report: rugcheck, lpAddresses: lpAddressesFromBest(best), creator });
  return { result, best, rugcheck, rug };
}

function lpAddressesFromBest(best) {
  if (!best || typeof best !== 'object') return [];
  const addrs = [best.pairAddress, best.pair_address, best.address];
  const lp = best.liquidity || {};
  if (lp.address) addrs.push(lp.address);
  return addrs.filter((a) => typeof a === 'string' && a.length >= 32);
}

// Creator/dev address may ride along on the PumpPortal migration payload
// (field name not officially documented — try likely keys).
export function extractCreator(event) {
  if (!event || typeof event !== 'object') return null;
  for (const key of ['creator', 'creatorAddress', 'deployer', 'deployerAddress', 'traderPublicKey', 'owner', 'authority']) {
    const val = event[key];
    if (typeof val === 'string' && val.length >= 32) return val;
  }
  return null;
}

async function pollCoin(mint, state) {
  state.polls += 1;
  if (state.polls % CONFIG.RUGCHECK_REFRESH_EVERY_N_POLLS === 0 || !state.rugcheck) {
    state.rugcheck = await getRugcheckReport(mint);
  }
  const pairs = await getDexscreenerPairs(mint);
  const best = (pairs && pairs[0]) || {};
  const price = safeFloat(best.priceUsd);
  if (state.firstPrice == null && price) state.firstPrice = price;
  if (price) state.peakPrice = state.peakPrice ? Math.max(state.peakPrice, price) : price;
  const momentum = state.firstPrice && price
    ? ((price - state.firstPrice) / state.firstPrice) * 100 : 0;
  const drawdown = state.peakPrice && price
    ? ((state.peakPrice - price) / state.peakPrice) * 100 : 0;

  const result = scoreToken(mint, best, state.rugcheck || {}, momentum);
  const volumeH1 = ((best.volume || {}).h1) || 0;
  state.result = { ...result, volume_h1: volumeH1, momentum_pct: Math.round(momentum * 10) / 10 };
  state.drawdown = Math.round(drawdown * 10) / 10;

  // Rug DD runs synchronously off the SAME already-fetched report/pair
  // (zero extra requests, zero added latency). The Solana RPC fallback is
  // deliberately NOT in this hot path (see rugSignals.js) — unknown
  // holder data stays "unknown" instead of stalling the poll loop.
  try {
    state.rug = scoreRugRisk({
      report: state.rugcheck || {}, lpAddresses: lpAddressesFromBest(best), creator: state.creator || null,
    });
  } catch (e) {
    console.warn('Rug signals failed for', mint, e);
  }

  if (result.is_high_potential) state.consecutive += 1;
  else state.consecutive = 0;

  // Hard-exclude high rug-risk coins from notifications even if momentum
  // qualifies — they stay listed in the UI, tagged red (see render()).
  const rugBlocked = state.rug && state.rug.isHighRugRisk;
  if (result.is_high_potential &&
      state.consecutive >= CONFIG.MIN_POLLS_BEFORE_ALERT &&
      drawdown < CONFIG.PEAK_DRAWDOWN_STOP_PCT &&
      !rugBlocked &&
      !state.alerted) {
    state.alerted = true;
    markSeen(mint, state.result);
    notifyHighPotential(state.result);
  }
  if (rugBlocked && result.is_high_potential && !state.rugLogged) {
    state.rugLogged = true;
    console.info(`[rug-block] ${mint}: momentum score ${result.score} qualifies but ruggedScore ${state.rug.ruggedScore} >= ${CONFIG.RUG_RISK_THRESHOLD} — notification suppressed.`);
  }
  render();
}

async function pollAll() {
  const now = Date.now();
  for (const [mint, state] of tracked) {
    if (now > state.deadline) {
      tracked.delete(mint);
      markSeen(mint, state.result);
      continue;
    }
    try {
      await pollCoin(mint, state);
    } catch (e) {
      console.warn('Poll failed for', mint, e);
    }
  }
  render();
}

function trackMint(mint, creator = null) {
  if (!mint || tracked.has(mint) || seen[mint]) return;
  tracked.set(mint, {
    firstPrice: null, peakPrice: null, polls: 0, consecutive: 0,
    rugcheck: null, deadline: Date.now() + CONFIG.MONITOR_WINDOW_MINUTES * 60 * 1000,
    result: null, rug: null, rugLogged: false, drawdown: 0, alerted: false, creator,
  });
  render();
}

function riskText(result) {
  if (!result) return '-';
  const flags = (((result.raw || {}).rugcheck || {}).risks || []);
  if (flags.length) return flags.map((f) => `${f.name} (${f.level})`).join('; ');
  const noReport = (result.reasons || []).some((r) => r.includes('RugCheck has no report'));
  return noReport ? 'no report yet' : 'clean';
}

function rugBadge(rug) {
  if (!rug) return '<span class="rug rug-na">…</span>';
  const cls = rug.isHighRugRisk ? 'rug-red' : (rug.ruggedScore >= 30 ? 'rug-yellow' : 'rug-green');
  const title = (rug.details || []).map((d) => `${d.triggered ? '✖' : '✔'} ${d.label}`).join('\n');
  const flagList = (rug.flags || []).map((f) => f.label).join('; ');
  return `<span class="rug ${cls}" title="${title.replace(/"/g, '&quot;')}">${rug.ruggedScore}${flagList ? ' — ' + flagList.replace(/</g, '&lt;') : ''}</span>`;
}

function render() {
  const tbody = $('results');
  const rows = [...tracked.entries()].map(([mint, s]) => {
    const r = s.result;
    const alertCell = s.alerted ? 'alerted'
      : (s.rug && s.rug.isHighRugRisk) ? `HIGH RUG RISK (${s.consecutive}/${CONFIG.MIN_POLLS_BEFORE_ALERT})`
      : (s.consecutive + '/' + CONFIG.MIN_POLLS_BEFORE_ALERT);
    return `<tr><td title="${mint}">${mint.slice(0, 8)}…</td>` +
      `<td><button onclick="copyMint('${mint}')" title="Copy full mint address">Copy</button></td>` +
      `<td>${r ? r.score : '…'}</td>` +
      `<td class="rugcell">${rugBadge(s.rug)}</td>` +
      `<td>${r ? '$' + Math.round(r.liquidity_usd).toLocaleString() : '…'}</td>` +
      `<td>${r ? (r.momentum_pct ?? 0) + '%' : '…'}</td>` +
      `<td>${riskText(r)}</td>` +
      `<td>${alertCell}</td></tr>`;
  });
  tbody.innerHTML = rows.join('') || '<tr><td colspan="8">No coins tracked yet — press Start Monitoring.</td></tr>';
  $('trackedCount').textContent = String(tracked.size);
}

export function startMonitoring() {
  if (pumpHandle) return;
  requestPermissionOnLoad();
  pumpHandle = listenForMigrations(
    (event) => {
      const mint = extractMintAddress(event);
      if (mint) trackMint(mint, extractCreator(event));
    },
    (status) => { $('wsStatus').textContent = status; },
  );
  pollTimer = setInterval(pollAll, CONFIG.POLL_INTERVAL_SECONDS * 1000);
  $('startBtn').disabled = true;
  $('stopBtn').disabled = false;
  render();
}

export function stopMonitoring() {
  if (pumpHandle) { pumpHandle.stop(); pumpHandle = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  $('startBtn').disabled = false;
  $('stopBtn').disabled = true;
  $('wsStatus').textContent = 'stopped';
}

export function scanNow() {
  pollAll();
}

// Expose for inline onclick handlers in index.html.
window.startMonitoring = startMonitoring;
window.stopMonitoring = stopMonitoring;
window.scanNow = scanNow;
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts where clipboard API is unavailable.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }
}
window.copyMint = async (mint) => {
  await copyText(mint);
};
let lastSingleMint = '';
window.copySingle = async () => {
  if (lastSingleMint) await copyText(lastSingleMint);
};
window.scanSingle = async () => {
  const mint = $('mintInput').value.trim();
  if (!mint) return;
  $('singleResult').textContent = 'Scanning…';
  try {
    const { result, rug } = await scanCoin(mint);
    markSeen(mint, result);
    lastSingleMint = mint;
    $('copySingleBtn').disabled = false;
    if (isHighPotential(result) && !rug.isHighRugRisk) notifyHighPotential(result);
    $('singleResult').textContent =
      `score ${result.score} | rug ${rug.ruggedScore}${rug.isHighRugRisk ? ' HIGH RUG RISK' : ''} | liquidity $${Math.round(result.liquidity_usd).toLocaleString()} | ` +
      `risk: ${riskText(result)} | ${(result.reasons || []).join('; ')}` +
      (rug.flags.length ? ` | RUG FLAGS: ${rug.flags.map((f) => f.label).join('; ')}` : '');
  } catch (e) {
    $('singleResult').textContent = 'Scan failed: ' + e;
  }
};

render();
