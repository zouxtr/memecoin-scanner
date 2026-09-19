// store.js — port of seen_store.py persistence to localStorage.
// Key = mint address, value = { scoredAt, result }. Capped at 5000
// entries (oldest evicted), mirroring the Python trim.
const PREFIX = 'memecoin-scanner:seen:';
const MAX_ENTRIES = 5000;
const INDEX_KEY = 'memecoin-scanner:seen-index';

function readIndex() {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeIndex(index) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch (e) {
    console.warn('localStorage index write failed:', e);
  }
}

export function loadSeen() {
  const seen = {};
  for (const mint of readIndex()) {
    try {
      const raw = localStorage.getItem(PREFIX + mint);
      if (raw) seen[mint] = JSON.parse(raw);
    } catch {}
  }
  return seen;
}

export function markSeen(mint, result) {
  const entry = { scoredAt: new Date().toISOString(), result: result || null };
  try {
    localStorage.setItem(PREFIX + mint, JSON.stringify(entry));
  } catch (e) {
    console.warn('localStorage write failed:', e);
    return;
  }
  let index = readIndex().filter((m) => m !== mint);
  index.push(mint);
  while (index.length > MAX_ENTRIES) {
    const oldest = index.shift();
    try { localStorage.removeItem(PREFIX + oldest); } catch {}
  }
  writeIndex(index);
}

export function isSeen(mint) {
  return readIndex().includes(mint);
}
