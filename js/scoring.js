// scoring.js — port of scoring.py (same math, same thresholds/weights).
// Imports constants from config.js; no network access here.
import { CONFIG, WEIGHTS, IMPERSONATION_KEYWORDS, IMPERSONATION_LEGITIMACY_WORDS } from './config.js';

function normalize(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isLikelyImpersonation(name, symbol) {
  const combined = normalize(name) + normalize(symbol);
  if (!combined) return false;
  const hasCeleb = IMPERSONATION_KEYWORDS.some((kw) => combined.includes(kw));
  if (!hasCeleb) return false;
  return IMPERSONATION_LEGITIMACY_WORDS.some((w) => combined.includes(w));
}

export function liquidityPoints(liquidityUsd, marketCapUsd) {
  if (!marketCapUsd) {
    if (liquidityUsd >= CONFIG.MIN_LIQUIDITY_USD * 4) return WEIGHTS.liquidity;
    if (liquidityUsd >= CONFIG.MIN_LIQUIDITY_USD * 2) return WEIGHTS.liquidity * 0.7;
    if (liquidityUsd >= CONFIG.MIN_LIQUIDITY_USD) return WEIGHTS.liquidity * 0.4;
    return 0;
  }
  const ratio = liquidityUsd / marketCapUsd;
  if (ratio >= 0.5) return WEIGHTS.liquidity;
  if (ratio >= 0.3) return WEIGHTS.liquidity * 0.7;
  if (ratio >= 0.15) return WEIGHTS.liquidity * 0.4;
  return 0;
}

export function volumePoints(volumeH1, liquidityUsd) {
  if (!liquidityUsd) return 0;
  const ratio = volumeH1 / liquidityUsd;
  if (ratio < 0.3) return 0;
  if (ratio < 1) return WEIGHTS.volume * 0.3;
  if (ratio <= 5) return WEIGHTS.volume;
  if (ratio < CONFIG.MAX_VOLUME_TO_LIQUIDITY_RATIO) return WEIGHTS.volume * 0.4;
  return 0;
}

export function momentumPoints(momentumPct) {
  if (momentumPct < 5) return 0;
  if (momentumPct < 15) return WEIGHTS.momentum * 0.35;
  if (momentumPct <= 60) return WEIGHTS.momentum;
  if (momentumPct < 80) return WEIGHTS.momentum * 0.5;
  return 0;
}

export function classifyPotential(marketCapUsd, momentumPct, volumeH1, liquidityUsd) {
  const ratio = liquidityUsd ? volumeH1 / liquidityUsd : 0;
  const comfortable = liquidityUsd >= CONFIG.MIN_LIQUIDITY_USD * 1.5;
  const veryComfortable = liquidityUsd >= CONFIG.MIN_LIQUIDITY_USD * 3;
  if (momentumPct >= 80) return 'Long runner: NO - already heavily pumped, late entry';
  if (!comfortable) {
    return `Long runner: NO - liquidity ($${Math.round(liquidityUsd).toLocaleString()}) too close to minimum, not deep enough to be stable`;
  }
  const earlyHot = marketCapUsd && marketCapUsd < 60000 && momentumPct >= 25 && ratio >= 1;
  const stillSmall = marketCapUsd && marketCapUsd < 150000;
  if (earlyHot && veryComfortable) return 'Long runner: YES (speculative) - low market cap + strong early momentum + high volume + unusually deep liquidity, but most such coins still go to 0';
  if (earlyHot) return 'Long runner: LIKELY YES (speculative) - low market cap + strong early momentum + high volume, stable liquidity, still high rug risk';
  if (stillSmall && veryComfortable) return 'Long runner: LIKELY YES - still small by market cap, unusually deep liquidity for its size';
  if (stillSmall) return 'Long runner: LIKELY NO - still small by market cap, but momentum/volume profile not convincing';
  if (marketCapUsd && marketCapUsd <= CONFIG.EXTENDED_MAX_MARKET_CAP_USD) {
    return 'Long runner: YES (rarer, sustained growth) - above the usual early range but passed the stricter extended-zone checks (clean RugCheck report, deep liquidity)';
  }
  return "Long runner: NO - no longer an early entry, momentum looks largely spent";
}

export function weightedLpLockedPct(rugcheckReport) {
  const markets = (rugcheckReport && rugcheckReport.markets) || [];
  let totalWeight = 0;
  let weightedLocked = 0;
  for (const market of markets) {
    const lp = (market || {}).lp || {};
    if (lp.pctReserve == null || lp.lpLockedPct == null) continue;
    totalWeight += lp.pctReserve;
    weightedLocked += lp.pctReserve * lp.lpLockedPct;
  }
  if (totalWeight <= 0) return null;
  return weightedLocked / totalWeight;
}

function block(mint, reasons, liquidityUsd, marketCapUsd, extra = {}) {
  return {
    mint, score: 0, reasons, liquidity_usd: liquidityUsd,
    market_cap_usd: marketCapUsd, is_high_potential: false,
    potential_label: '', raw: {}, ...extra,
  };
}

export function scoreToken(mint, bestPair, rugcheckReport, momentumPct = 0) {
  if (!bestPair || Object.keys(bestPair).length === 0) {
    return { mint, score: 0, reasons: ['no DexScreener pair - probably not indexed yet'], liquidity_usd: 0, market_cap_usd: 0, is_high_potential: false, potential_label: '' };
  }
  const liquidityUsd = ((bestPair.liquidity || {}).usd) || 0;
  const marketCapUsd = bestPair.marketCap || bestPair.fdv || 0;
  const volumeH1 = ((bestPair.volume || {}).h1) || 0;
  const baseToken = bestPair.baseToken || {};

  if (isLikelyImpersonation(baseToken.name || '', baseToken.symbol || '')) {
    return block(mint, [`'${baseToken.name || baseToken.symbol}' claims a real link to a public figure (official/verified/...) - skipping`], liquidityUsd, marketCapUsd);
  }
  if (liquidityUsd < CONFIG.MIN_LIQUIDITY_USD) {
    return block(mint, [`liquidity too low ($${liquidityUsd.toLocaleString()}) - below minimum $${CONFIG.MIN_LIQUIDITY_USD.toLocaleString()}`], liquidityUsd, marketCapUsd);
  }
  const volLiqRatio = liquidityUsd ? volumeH1 / liquidityUsd : 0;
  if (volLiqRatio > CONFIG.MAX_VOLUME_TO_LIQUIDITY_RATIO) {
    return block(mint, [`volume(1h)/liquidity ratio too high (${volLiqRatio.toFixed(1)}x) - likely wash trading, skipping`], liquidityUsd, marketCapUsd);
  }
  if (marketCapUsd && marketCapUsd > CONFIG.EXTENDED_MAX_MARKET_CAP_USD) {
    return block(mint, [`market cap too high ($${Math.round(marketCapUsd).toLocaleString()}) - above hard cap $${CONFIG.EXTENDED_MAX_MARKET_CAP_USD.toLocaleString()}`], liquidityUsd, marketCapUsd);
  }
  if (marketCapUsd && marketCapUsd > CONFIG.MAX_MARKET_CAP_USD) {
    const clean = Boolean(rugcheckReport) && !((rugcheckReport.risks || []).length);
    const deepEnough = liquidityUsd >= CONFIG.EXTENDED_ZONE_MIN_LIQUIDITY_USD;
    if (!(clean && deepEnough)) {
      return block(mint, [`market cap $${Math.round(marketCapUsd).toLocaleString()} above early cap $${CONFIG.MAX_MARKET_CAP_USD.toLocaleString()} and fails extended-zone requirements (clean RugCheck: ${clean ? 'yes' : 'NO'}, liquidity >= $${CONFIG.EXTENDED_ZONE_MIN_LIQUIDITY_USD.toLocaleString()}: ${deepEnough ? 'yes' : 'NO'})`], liquidityUsd, marketCapUsd);
    }
  }
  if (momentumPct >= 80) {
    return block(mint, [`momentum too high (+${momentumPct.toFixed(0)}%) - likely already pumped and about to dump`], liquidityUsd, marketCapUsd);
  }
  const lpLockedPct = rugcheckReport ? weightedLpLockedPct(rugcheckReport) : null;
  if (lpLockedPct != null && lpLockedPct < CONFIG.MIN_LP_LOCKED_PCT) {
    return block(mint, [`only ~${lpLockedPct.toFixed(0)}% of liquidity locked (LP lock), below minimum ${CONFIG.MIN_LP_LOCKED_PCT.toFixed(0)}% - liquidity rug risk`], liquidityUsd, marketCapUsd);
  }
  if (CONFIG.BLOCK_ON_LOW_LIQUIDITY_RISK && rugcheckReport) {
    const risks = rugcheckReport.risks || [];
    const lowLiq = risks.find((r) => r && typeof r === 'object' && String(r.name || '').toLowerCase().includes('low liquidity'));
    if (lowLiq) {
      return block(mint, [`RugCheck flagged '${lowLiq.name}' (level=${lowLiq.level}) - hard block`], liquidityUsd, marketCapUsd);
    }
  }
  const insiders = (rugcheckReport && (rugcheckReport.graphInsidersDetected || 0)) || 0;
  if (insiders >= CONFIG.MAX_INSIDER_CLUSTERS) {
    return block(mint, [`RugCheck found ${insiders} insider wallet clusters - above threshold ${CONFIG.MAX_INSIDER_CLUSTERS}`], liquidityUsd, marketCapUsd);
  }
  if (rugcheckReport) {
    const risks = rugcheckReport.risks || [];
    const danger = risks.find((r) => r && typeof r === 'object' && String(r.level || '').toLowerCase() === 'danger');
    if (danger) return block(mint, [`RugCheck flagged '${danger.name}' at 'danger' level - hard block`], liquidityUsd, marketCapUsd);
    const names = new Set(risks.filter((r) => r && typeof r === 'object').map((r) => String(r.name || '').toLowerCase()));
    if ([...names].some((n) => n.includes('mint') && n.includes('authority'))) {
      return block(mint, ['mint authority still active - owner can print new tokens - hard block'], liquidityUsd, marketCapUsd);
    }
    if ([...names].some((n) => n.includes('freeze'))) {
      return block(mint, ['freeze authority still active - owner can freeze holder wallets - hard block'], liquidityUsd, marketCapUsd);
    }
    if ([...names].some((n) => n.includes('market cap') && n.includes('holder'))) {
      return block(mint, ['RugCheck flagged high market cap per holder - concentrated distribution - hard block'], liquidityUsd, marketCapUsd);
    }
  }

  const reasons = [];
  let points = 0;
  const liqPts = liquidityPoints(liquidityUsd, marketCapUsd);
  if (liqPts) { points += liqPts; reasons.push(`liquidity $${Math.round(liquidityUsd).toLocaleString()}`); }
  const volPts = volumePoints(volumeH1, liquidityUsd);
  if (volPts) { points += volPts; reasons.push(`1h volume strong vs liquidity ($${Math.round(volumeH1).toLocaleString()})`); }
  const momPts = momentumPoints(momentumPct);
  if (momPts) { points += momPts; reasons.push(`real momentum +${momentumPct.toFixed(1)}% since tracking started`); }

  if (!rugcheckReport || Object.keys(rugcheckReport).length === 0) {
    reasons.push('RugCheck has no report for this coin yet (too new) - risk points withheld cautiously');
  } else {
    const risks = rugcheckReport.risks || [];
    points += WEIGHTS.no_mint_authority;
    reasons.push('mint authority revoked');
    points += WEIGHTS.no_freeze_authority;
    reasons.push('freeze authority revoked');
    const high = risks.filter((r) => r && typeof r === 'object' && String(r.level || '').toLowerCase() === 'high');
    if (high.length === 0) points += WEIGHTS.low_risk_flags;
    else reasons.push(`${high.length} 'high'-severity RugCheck risk flags (below 'danger', not blocking by itself)`);
    if (insiders) reasons.push(`RugCheck found ${insiders} insider wallet cluster(s) - below threshold, informational`);
  }

  const score = Math.round(points * 10) / 10;
  return {
    mint, score, reasons, liquidity_usd: liquidityUsd, market_cap_usd: marketCapUsd,
    is_high_potential: score >= CONFIG.HIGH_POTENTIAL_THRESHOLD,
    potential_label: classifyPotential(marketCapUsd, momentumPct, volumeH1, liquidityUsd),
  };
}
