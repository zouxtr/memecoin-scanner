// stockScoring.js — "potential" score for penny stocks (0-100).
// Inputs: day change %, relative volume (today/avg), price.
// Thresholds live in config.js as STOCK_* constants.
import { CONFIG } from './config.js';

export function scoreStock({ changePct = 0, relVolume = null, price = 0 } = {}) {
  const reasons = [];
  let score = 0;

  // Momentum: % gain component (max ~50 pts).
  const gain = Number.isFinite(changePct) ? changePct : 0;
  const gainPts = Math.max(0, Math.min(50, gain * CONFIG.STOCK_GAIN_WEIGHT_PER_PCT));
  score += gainPts;
  reasons.push(`gain ${gain.toFixed(1)}% -> +${gainPts.toFixed(0)}`);

  // Relative volume component (max ~35 pts). Missing avg volume = neutral.
  if (relVolume != null && Number.isFinite(relVolume) && relVolume > 0) {
    const rvPts = Math.max(0, Math.min(35, (relVolume - 1) * CONFIG.STOCK_RVOL_WEIGHT));
    score += rvPts;
    reasons.push(`relVol ${relVolume.toFixed(2)}x -> +${rvPts.toFixed(0)}`);
  } else {
    reasons.push('no avg-volume baseline; volume neutral');
  }

  // Price component: cheaper (within cap) scores slightly higher (max ~15).
  if (price > 0 && price <= CONFIG.STOCK_MAX_PRICE) {
    const pricePts = Math.round(15 * (1 - price / CONFIG.STOCK_MAX_PRICE));
    score += pricePts;
    reasons.push(`price $${price} -> +${pricePts}`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const isHigh = score >= CONFIG.STOCK_POTENTIAL_THRESHOLD;
  return {
    score,
    isHighPotential: isHigh,
    potential_label: isHigh ? 'HIGH POTENTIAL' : (score >= 40 ? 'WATCH' : 'LOW'),
    reasons,
  };
}

export function relVolume(todayVolume, avgVolume) {
  if (!todayVolume || !avgVolume || avgVolume <= 0) return null;
  return todayVolume / avgVolume;
}
