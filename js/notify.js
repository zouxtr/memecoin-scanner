// notify.js — port of notifier.py email sending to the browser
// Notification API. Call requestPermissionOnLoad() on page load;
// notifyHighPotential() fires when a coin crosses the threshold.
import { CONFIG } from './config.js';

export async function requestPermissionOnLoad() {
  try {
    if (!('Notification' in window)) {
      console.warn('This browser does not support notifications.');
      return 'unsupported';
    }
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    return await Notification.requestPermission();
  } catch (e) {
    console.warn('Notification permission request failed:', e);
    return 'error';
  }
}

export function notifyHighPotential(result) {
  const title = `Memecoin alert: ${result.mint.slice(0, 8)}… score ${result.score}`;
  const body = `${result.potential_label || ''}\nLiquidity $${Math.round(result.liquidity_usd || 0).toLocaleString()} — click to open.`;
  console.info('[alert]', title, body, (result.reasons || []).join('; '));
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  } catch (e) {
    console.warn('Notification display failed:', e);
  }
}

export function isHighPotential(result) {
  return result && result.score >= CONFIG.HIGH_POTENTIAL_THRESHOLD;
}
