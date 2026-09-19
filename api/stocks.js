// Vercel serverless function — stock screener proxy. Keys stay server-side.
// GET /api/stocks?action=movers[&maxPrice=5][&limit=20][&top=30]
// GET /api/stocks?action=quote&symbol=XYZ
//
// Discovery (market-wide, no fixed list required):
//   GET https://data.alpaca.markets/v1beta1/screener/stocks/movers?top=N
//     -> { gainers: [{symbol, price, change, percent_change}], losers, last_updated }
//   GET https://data.alpaca.markets/v1beta1/screener/stocks/most-actives?by=volume&top=N
//     -> { most_actives: [{symbol, volume, trade_count}], last_updated }
// Auth: APCA-API-KEY-ID + APCA-API-SECRET-KEY headers (paper/free tier OK).
// Free-tier rate limit: 200 req/min.
//
// Detail (optional, per-symbol, only for surfaced candidates):
//   Finnhub GET /v1/quote + /v1/stock/metric + /v1/stock/candle (60 calls/min).

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const ALPACA_BASE = 'https://data.alpaca.markets';

// Optional additive list: always-included symbols merged with screener results.
const PENNY_WATCHLIST = (
  'SNDL,GNUS,BBIG,CEI,AMC,BBBYQ,MULN,PROG,SOXS,SQQQ,' +
  'TELL,CTRM,EXPR,NAKD,ZOM,OCGN,NVOS,ATER,AEHL,IMCC'
).split(',');

// --- tiny in-memory cache (per lambda instance) ---
const cache = new Map(); // key -> { at, data }
const CACHE_TTL = {
  movers: 120 * 1000, // movers result cached 2 min
  quote: 60 * 1000,   // single quote cached 60 s
};
let lastFinnhubCall = 0;
let lastAlpacaCall = 0;
const FINNHUB_SPACING_MS = 1100; // ~54 calls/min worst case, under the 60/min free tier
const ALPACA_SPACING_MS = 350;   // ~170/min worst case, under the 200/min free tier

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function spacedFetch(url, { spacing, last, setLast, headers, label }) {
  const wait = spacing - (Date.now() - last());
  if (wait > 0) await sleep(wait);
  setLast(Date.now());
  const res = await fetch(url, { headers });
  if (res.status === 429) {
    const e = new Error(`${label} rate limit (429)`);
    e.status = 429;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`${label} upstream ${res.status}`);
    e.status = 502;
    throw e;
  }
  return res.json();
}

const finnhubFetch = (url) => spacedFetch(url, {
  spacing: FINNHUB_SPACING_MS,
  last: () => lastFinnhubCall,
  setLast: (t) => { lastFinnhubCall = t; },
  headers: undefined,
  label: 'Finnhub',
});

function alpacaHeaders() {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY_ID || '',
    'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET_KEY || '',
  };
}
const alpacaFetch = (url) => spacedFetch(url, {
  spacing: ALPACA_SPACING_MS,
  last: () => lastAlpacaCall,
  setLast: (t) => { lastAlpacaCall = t; },
  headers: alpacaHeaders(),
  label: 'Alpaca',
});

function getCached(key, ttl) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  return null;
}
function setCached(key, data) {
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
}

async function fetchQuote(token, symbol) {
  const key = `q:${symbol}`;
  const hit = getCached(key, CACHE_TTL.quote);
  if (hit) return hit;
  const q = await finnhubFetch(
    `${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(symbol)}&token=${token}`
  );
  const out = {
    symbol,
    price: q.c ?? null,
    prevClose: q.pc ?? null,
    open: q.o ?? null,
    high: q.h ?? null,
    low: q.l ?? null,
    change: q.d ?? null,
    changePct: q.dp ?? null,
  };
  setCached(key, out);
  return out;
}

async function fetchTodayVolume(token, symbol) {
  // /quote has no volume field; try daily candle (free tier) for today's volume.
  try {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 2 * 86400;
    const c = await finnhubFetch(
      `${FINNHUB_BASE}/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${token}`
    );
    if (c && c.s === 'ok' && Array.isArray(c.v) && c.v.length) return c.v[c.v.length - 1];
    return null;
  } catch {
    return null;
  }
}
async function fetchAvgVolume(token, symbol) {
  // /stock/metric is free-tier; failures resolve to null (never fatal).
  try {
    const key = `m:${symbol}`;
    const hit = getCached(key, CACHE_TTL.quote);
    if (hit) return hit;
    const m = await finnhubFetch(
      `${FINNHUB_BASE}/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${token}`
    );
    const avg = m?.metric?.['10DayAverageTradingVolume'] ?? null;
    const out = typeof avg === 'number' ? avg : null;
    setCached(key, out);
    return out;
  } catch {
    return null;
  }
}

// Market-wide discovery via Alpaca screener. Returns null if creds missing
// so the caller can fall back to the Finnhub watchlist scan.
async function discoverViaAlpaca(maxP, top) {
  if (!process.env.ALPACA_API_KEY_ID || !process.env.ALPACA_API_SECRET_KEY) return null;
  const [movers, actives] = await Promise.all([
    alpacaFetch(`${ALPACA_BASE}/v1beta1/screener/stocks/movers?top=${top}`),
    alpacaFetch(`${ALPACA_BASE}/v1beta1/screener/stocks/most-actives?by=volume&top=${top}`),
  ]);
  const bySymbol = new Map();
  for (const g of movers?.gainers || []) {
    if (typeof g.price !== 'number' || g.price > maxP || g.price <= 0) continue;
    bySymbol.set(g.symbol, {
      symbol: g.symbol,
      price: g.price,
      change: g.change ?? null,
      changePct: g.percent_change ?? null,
      volume: null,
      avgVolume: null,
      source: 'alpaca-movers',
    });
  }
  const activeVols = new Map((actives?.most_actives || []).map((a) => [a.symbol, a.volume]));
  // most-actives has no price field: enrich via latest trade; drop unpriced.
  for (const [sym, vol] of activeVols) {
    if (bySymbol.has(sym)) {
      bySymbol.get(sym).volume = vol;
      continue;
    }
    try {
      const t = await alpacaFetch(`${ALPACA_BASE}/v2/stocks/${encodeURIComponent(sym)}/trades/latest`);
      const price = t?.trade?.p;
      if (typeof price !== 'number' || price > maxP || price <= 0) continue;
      bySymbol.set(sym, { symbol: sym, price, change: null, changePct: null, volume: vol, avgVolume: null, source: 'alpaca-most-actives' });
    } catch { /* skip symbols that fail to price */ }
  }
  return {
    rows: [...bySymbol.values()],
    lastUpdated: movers?.last_updated || actives?.last_updated || null,
  };
}

// Legacy fallback: Finnhub scan of PENNY_WATCHLIST (used when Alpaca creds
// are absent, or when ?symbols= is explicitly passed).
async function discoverViaFinnhubWatchlist(token, maxP, list) {
  const rows = [];
  for (const sym of list) {
    try {
      const [q, avgVolume, volume] = [await fetchQuote(token, sym), await fetchAvgVolume(token, sym), await fetchTodayVolume(token, sym)];
      if (q.price == null || q.price > maxP || q.price <= 0) continue;
      rows.push({ ...q, volume, avgVolume, source: 'finnhub-watchlist-fallback' });
    } catch (e) {
      if (e && e.status === 429) break; // stop scanning, return what we have
    }
  }
  return rows;
}

export default async function handler(req, res) {
  try {
    const token = process.env.FINNHUB_API_KEY;
    if (!token) {
      return res.status(500).json({ error: 'FINNHUB_API_KEY not configured on server' });
    }
    const { action, symbol, symbols, maxPrice, limit, top } = req.query || {};

    if (action === 'quote') {
      if (!symbol || typeof symbol !== 'string') {
        return res.status(400).json({ error: 'missing ?symbol=' });
      }
      const sym = symbol.toUpperCase().trim();
      const [q, avgVolume, volume] = [await fetchQuote(token, sym), await fetchAvgVolume(token, sym), await fetchTodayVolume(token, sym)];
      return res.status(200).json({ ...q, volume, avgVolume, delayedNote: 'free-tier data may be delayed ~15min' });
    }

    if (action === 'movers' || action === undefined) {
      const maxP = parseFloat(maxPrice) || 5;
      const lim = Math.min(parseInt(limit, 10) || 20, 50);
      const topN = Math.min(Math.max(parseInt(top, 10) || 30, 1), 50);
      const cacheKey = `movers:${maxP}:${symbols || 'alpaca'}:${lim}:${topN}`;
      const hit = getCached(cacheKey, CACHE_TTL.movers);
      if (hit) return res.status(200).json(hit);

      let rows;
      let source = 'alpaca';
      let lastUpdated = null;
      if (typeof symbols === 'string' && symbols.trim()) {
        // Explicit symbol list: legacy Finnhub path.
        const list = symbols.toUpperCase().split(/[^A-Z.]+/).filter(Boolean).slice(0, 50);
        rows = await discoverViaFinnhubWatchlist(token, maxP, list);
        source = 'finnhub-explicit-symbols';
      } else {
        const found = await discoverViaAlpaca(maxP, topN).catch((e) => {
          if (e && e.status === 429) throw e;
          console.warn('Alpaca discovery failed, falling back to watchlist:', e.message);
          return null;
        });
        if (found) {
          rows = found.rows;
          lastUpdated = found.lastUpdated;
          // Merge additive watchlist (validated via Finnhub quote, capped to 10 to save quota).
          const extra = PENNY_WATCHLIST.filter((s) => !rows.some((r) => r.symbol === s)).slice(0, 10);
          const extraRows = await discoverViaFinnhubWatchlist(token, maxP, extra);
          rows = rows.concat(extraRows.map((r) => ({ ...r, source: 'watchlist-additive' })));
        } else {
          rows = await discoverViaFinnhubWatchlist(token, maxP, PENNY_WATCHLIST);
          source = 'finnhub-watchlist-fallback';
        }
      }
      rows.sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity));
      const out = { asOf: new Date().toISOString(), lastUpdated, source, maxPrice: maxP, count: rows.length, movers: rows.slice(0, lim), delayedNote: 'free-tier data may be delayed ~15min' };
      setCached(cacheKey, out);
      return res.status(200).json(out);
    }

    return res.status(400).json({ error: 'unknown action (use movers|quote)' });
  } catch (e) {
    const status = e && e.status === 429 ? 429 : 500;
    return res.status(status).json({ error: String((e && e.message) || e) });
  }
}
