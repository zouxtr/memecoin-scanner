// notify.js — port of notifier.py email sending to the browser
// Notification API. Call requestPermissionOnLoad() on page load;
// notifyHighPotential() fires when a coin crosses the threshold.
//
// Also owns the global on/off switch (persisted in localStorage) and a
// notification history log shared by the crypto + stock scanners.
import { CONFIG } from './config.js';

const ENABLED_KEY = 'memecoin-scanner:notifications-enabled';
const LOG_KEY = 'memecoin-scanner:notification-log';
const MAX_LOG = 100;

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

export function isNotificationsEnabled() {
  try {
    const v = localStorage.getItem(ENABLED_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

export function setNotificationsEnabled(on) {
  try {
    localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
  } catch (e) {
    console.warn('notification toggle persist failed:', e);
  }
  window.dispatchEvent(new CustomEvent('notifications-changed'));
}

export function getNotificationLog() {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
  } catch {
    return [];
  }
}

export function logNotification(entry) {
  try {
    const log = getNotificationLog();
    log.unshift({ at: new Date().toISOString(), ...entry });
    localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(0, MAX_LOG)));
  } catch (e) {
    console.warn('notification log write failed:', e);
  }
  window.dispatchEvent(new CustomEvent('notifications-changed'));
}

export function clearNotificationLog() {
  try {
    localStorage.removeItem(LOG_KEY);
  } catch {}
  window.dispatchEvent(new CustomEvent('notifications-changed'));
}

// kind: 'crypto' | 'stock'. Returns 'sent' | 'muted' | 'no-permission'.
// When the global switch is off, nothing is shown but the event is still
// logged (status 'muted') so the history panel reflects what happened.
export function notifyHighPotential(result, kind = 'crypto') {
  const id = String(result.mint ?? result.symbol ?? '?');
  const label = kind === 'stock' ? 'Stock' : 'Memecoin';
  const title = `${label} alert: ${id.slice(0, 8)}… score ${result.score}`;
  const body = `${result.potential_label || ''}\nLiquidity $${Math.round(result.liquidity_usd || 0).toLocaleString()} — click to open.`;
  console.info('[alert]', title, body, (result.reasons || []).join('; '));
  if (!isNotificationsEnabled()) {
    logNotification({ kind, id, score: result.score, status: 'muted' });
    return 'muted';
  }
  let shown = false;
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body });
      shown = true;
    }
  } catch (e) {
    console.warn('Notification display failed:', e);
  }
  logNotification({ kind, id, score: result.score, status: shown ? 'sent' : 'no-permission' });
  return shown ? 'sent' : 'no-permission';
}

export function isHighPotential(result) {
  return result && result.score >= CONFIG.HIGH_POTENTIAL_THRESHOLD;
}
