// rugSignals.js — DD rug-pull detection, run in parallel with the
// existing RugCheck call for each candidate coin.
//
// Data comes ONLY from free, no-key endpoints:
//   - RugCheck report (already fetched): mint/freeze authorities,
//     topHolders[].pct, creator/creatorBalance, markets[].lp, lockers
//   - DexScreener pair data (already fetched): pairAddress for LP lookup
//   - Public Solana RPC (best-effort fallback for holder list when the
//     RugCheck report has no topHolders yet — degrades to "unknown",
//     never inflates the score)
//
// Output: ruggedScore 0-100 (higher = riskier), SEPARATE from the
// momentum/potential score in scoring.js. A coin can score high on
// momentum and still be flagged red here.
import { CONFIG } from './config.js';

// Weights sum to 100.
const SIGNAL_WEIGHTS = {
  mintAuthority: 30,
  freezeAuthority: 20,
  holderConcentration: 20,
  lpLock: 20,
  devHolding: 10,
};

// --- Public Solana RPC fallback (getTokenLargestAccounts) ---
// Simple client-side spacing + backoff: at most 1 RPC call per
// RPC_MIN_SPACING_MS, up to RPC_MAX_RETRIES on 429 with exponential
// backoff. Any failure resolves to null (unknown), never throws.
let _lastRpcAt = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function rpcCall(method, params) {
  const spacing = CONFIG.SOLANA_RPC_MIN_SPACING_MS || 1500;
  const wait = spacing - (Date.now() - _lastRpcAt);
  if (wait > 0) await sleep(wait);
  let delay = CONFIG.SOLANA_RPC_RETRY_BASE_MS || 2000;
  const retries = CONFIG.SOLANA_RPC_MAX_RETRIES ?? 2;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      _lastRpcAt = Date.now();
      const res = await fetch(CONFIG.SOLANA_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: attempt, method, params }),
      });
      if (res.status === 429) throw new Error('HTTP 429');
      if (!res.ok) return null;
      const json = await res.json();
      if (json.error) return null;
      return json.result ?? null;
    } catch (e) {
      if (attempt > retries) {
        console.warn('Solana RPC fallback failed:', e);
        return null;
      }
      await sleep(delay);
      delay *= 2;
    }
  }
  return null;
}

export async function getTopHoldersViaRpc(mint) {
  // getTokenLargestAccounts returns top 20 by balance with uiAmount;
  // without total supply we can only use it if the RugCheck report
  // (which carries supply via token decimals/supply) is also present —
  // caller merges. Returns raw accounts or null.
  const result = await rpcCall('getTokenLargestAccounts', [mint]);
  return (result && result.value) || null;
}

// --- Individual checks (pure, operate on already-fetched data) ---

function checkMintAuthority(report) {
  // RugCheck top-level mintAuthority: null (or empty) = revoked (safe).
  // Also catch the risk-flag naming as a second source.
  const active = report && report.mintAuthority != null && report.mintAuthority !== '';
  const flagged = (report?.risks || []).some(
    (r) => r && typeof r === 'object' && /mint/i.test(String(r.name || '')) && /authority/i.test(String(r.name || '')),
  );
  if (active || flagged) {
    return { key: 'mint', triggered: true, label: 'Mint authority ACTIVE — dev can print unlimited supply' };
  }
  return { key: 'mint', triggered: false, label: 'Mint authority revoked' };
}

function checkFreezeAuthority(report) {
  const active = report && report.freezeAuthority != null && report.freezeAuthority !== '';
  const flagged = (report?.risks || []).some(
    (r) => r && typeof r === 'object' && /freeze/i.test(String(r.name || '')),
  );
  if (active || flagged) {
    return { key: 'freeze', triggered: true, label: "Freeze authority ACTIVE — dev can freeze holders so they can't sell" };
  }
  return { key: 'freeze', triggered: false, label: 'Freeze authority revoked' };
}

function topHoldersList(report) {
  const th = report && report.topHolders;
  return Array.isArray(th) && th.length ? th : null;
}

function checkHolderConcentration(report, lpAddresses) {
  const holders = topHoldersList(report);
  if (!holders) {
    return { key: 'concentration', triggered: false, unknown: true, label: 'Holder list unavailable — concentration unknown' };
  }
  const lpSet = new Set((lpAddresses || []).filter(Boolean));
  // Exclude known LP/pool addresses, then check the largest remainder.
  const rest = holders.filter((h) => !lpSet.has(h.address) && !lpSet.has(h.owner));
  const top = rest.reduce((a, b) => ((b.pct || 0) > (a.pct || 0) ? b : a), { pct: 0 });
  const threshold = CONFIG.TOP_HOLDER_PCT_THRESHOLD ?? 8;
  if ((top.pct || 0) > threshold) {
    return {
      key: 'concentration', triggered: true,
      label: `Top holder ${(top.address || '').slice(0, 8)}… holds ${(top.pct || 0).toFixed(1)}% of supply (over ${threshold}%)`,
    };
  }
  return { key: 'concentration', triggered: false, label: `Top non-LP holder ${(top.pct || 0).toFixed(1)}% (under ${threshold}%)` };
}

function checkLpLock(report) {
  // Primary: RugCheck lockers[] non-empty, or weighted locked % >= threshold.
  const lockers = report && report.lockers;
  if (Array.isArray(lockers) && lockers.length > 0) {
    return { key: 'lplock', triggered: false, label: `LP locked via locker (${lockers.length} locker(s))` };
  }
  const markets = (report && report.markets) || [];
  let totalWeight = 0;
  let weightedLocked = 0;
  let sawData = false;
  for (const m of markets) {
    const lp = (m || {}).lp || {};
    if (lp.pctReserve == null || lp.lpLockedPct == null) continue;
    sawData = true;
    totalWeight += lp.pctReserve;
    weightedLocked += lp.pctReserve * lp.lpLockedPct;
  }
  if (sawData && totalWeight > 0) {
    const pct = weightedLocked / totalWeight;
    if (pct < (CONFIG.MIN_LP_LOCKED_PCT ?? 50)) {
      return { key: 'lplock', triggered: true, label: `LP NOT locked — only ~${pct.toFixed(0)}% locked, deployer can pull liquidity` };
    }
    return { key: 'lplock', triggered: false, label: `LP ~${pct.toFixed(0)}% locked` };
  }
  return { key: 'lplock', triggered: false, unknown: true, label: 'LP lock status unknown (no locker/markets data yet)' };
}

function checkDevHolding(report, creator) {
  const holders = topHoldersList(report);
  const threshold = CONFIG.DEV_HOLDING_PCT_THRESHOLD ?? 5;
  if (!creator) {
    return { key: 'dev', triggered: false, unknown: true, label: 'Creator address unknown — dev holding unchecked' };
  }
  if (!holders) {
    // RugCheck also exposes creatorBalance directly on the report.
    const cb = report && report.creatorBalance;
    if (cb != null && cb > threshold) {
      return { key: 'dev', triggered: true, label: `Creator holds ~${Number(cb).toFixed(1)}% (over ${threshold}%)` };
    }
    return { key: 'dev', triggered: false, unknown: cb == null, label: cb == null ? 'Dev holding unknown' : `Creator holds ~${Number(cb).toFixed(1)}%` };
  }
  const entry = holders.find((h) => h.address === creator || h.owner === creator);
  const pct = entry ? entry.pct || 0 : 0;
  if (pct > threshold) {
    return { key: 'dev', triggered: true, label: `Creator wallet holds ${pct.toFixed(1)}% of supply (over ${threshold}%)` };
  }
  return { key: 'dev', triggered: false, label: `Creator wallet holds ${pct.toFixed(1)}%` };
}

// --- Combined score ---

export function scoreRugRisk({ report, lpAddresses, creator }) {
  const checks = [
    { ...checkMintAuthority(report), weight: SIGNAL_WEIGHTS.mintAuthority },
    { ...checkFreezeAuthority(report), weight: SIGNAL_WEIGHTS.freezeAuthority },
    { ...checkHolderConcentration(report, lpAddresses), weight: SIGNAL_WEIGHTS.holderConcentration },
    { ...checkLpLock(report), weight: SIGNAL_WEIGHTS.lpLock },
    { ...checkDevHolding(report, creator), weight: SIGNAL_WEIGHTS.devHolding },
  ];
  let score = 0;
  const flags = [];
  for (const c of checks) {
    if (c.triggered) {
      score += c.weight;
      flags.push({ key: c.key, label: c.label });
    }
  }
  score = Math.min(100, Math.round(score));
  const threshold = CONFIG.RUG_RISK_THRESHOLD ?? 70;
  return {
    ruggedScore: score,
    isHighRugRisk: score >= threshold,
    flags, // only triggered ones
    details: checks.map(({ key, triggered, unknown, label }) => ({ key, triggered, unknown: !!unknown, label })),
  };
}

// Manual deep-check helper (NOT used in the auto-poll loop): runs the RPC
// holder fallback when the report lacks topHolders, then scores. Resolves
// to a scoreRugRisk result; RPC failure just leaves concentration/dev as
// "unknown". NOTE: the raw RPC accounts are stashed on `_rpcHolders` for
// inspection only — percentage checks still require the report's own
// topHolders[].pct, so this never invents percentages from raw amounts.
export async function scoreRugRiskWithRpcFallback({ mint, report, lpAddresses, creator }) {
  let effectiveReport = report;
  if (!topHoldersList(report) && mint) {
    const rpcHolders = await getTopHoldersViaRpc(mint);
    if (rpcHolders) {
      // RPC accounts lack pct; mark unknown-supply so checks treat
      // them as unavailable rather than guessing percentages.
      effectiveReport = { ...report, _rpcHolders: rpcHolders };
    }
  }
  return scoreRugRisk({ report: effectiveReport, lpAddresses, creator });
}
