// pump.js — port of pumpportal_client.py: graduation listener as a
// browser WebSocket client. Same subscribe + same ACK filtering.
import { CONFIG } from './config.js';

const RECONNECT_DELAY_MS = 10000;

export function listenForMigrations(onMigration, onStatus) {
  let ws = null;
  let stopped = false;

  function connect() {
    if (stopped) return;
    onStatus && onStatus('connecting');
    try {
      ws = new WebSocket(CONFIG.PUMPPORTAL_WS_URL);
    } catch (e) {
      console.warn('PumpPortal connect failed, retrying:', e);
      setTimeout(connect, RECONNECT_DELAY_MS);
      return;
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ method: 'subscribeMigration' }));
      onStatus && onStatus('connected');
    };
    ws.onmessage = (msg) => {
      let event;
      try {
        event = JSON.parse(msg.data);
      } catch {
        return;
      }
      // Subscribe ACK, not a real migration event (see pumpportal_client.py).
      if (event && typeof event === 'object' && !Array.isArray(event) &&
          Object.keys(event).length === 1 && 'message' in event) {
        console.info('PumpPortal ack:', event.message);
        return;
      }
      console.info('RAW migration payload:', event);
      onMigration(event);
    };
    ws.onerror = (e) => console.warn('PumpPortal websocket error:', e);
    ws.onclose = () => {
      onStatus && onStatus('disconnected');
      if (!stopped) {
        console.warn(`PumpPortal connection dropped - reconnect in ${RECONNECT_DELAY_MS / 1000}s.`);
        setTimeout(connect, RECONNECT_DELAY_MS);
      }
    };
  }

  connect();
  return { stop() { stopped = true; try { ws && ws.close(); } catch {} } };
}
