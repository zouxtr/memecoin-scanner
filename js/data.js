// data.js — port of data_sources.py. DexScreener + RugCheck via fetch().
// Each isolated in its own function: a CORS/network failure in one
// resolves to a safe empty value and never breaks the other.
function sortPairsByLiquidity(pairs) {
  return pairs.sort((a, b) => (((b.liquidity || {}).usd) || 0) - (((a.liquidity || {}).usd) || 0));
}

export async function getDexscreenerPairs(mintAddress) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mintAddress)}`);
    if (!res.ok) return [];
    const json = await res.json();
    return sortPairsByLiquidity(json.pairs || []);
  } catch (e) {
    console.warn('DexScreener fail for', mintAddress, e);
    return [];
  }
}

export async function getRugcheckReport(mintAddress) {
  // 400/404 = coin real but not indexed yet by RugCheck — quiet empty,
  // same as data_sources.py. Other failures also resolve to {}.
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mintAddress)}/report`, {
      headers: { Accept: 'application/json' },
    });
    if (res.status === 400 || res.status === 404) return {};
    if (!res.ok) return {};
    return await res.json();
  } catch (e) {
    console.warn('RugCheck fail for', mintAddress, e);
    return {};
  }
}

// Port of extract_mint_address(): PumpPortal publishes no fixed schema,
// so try the most likely keys; log the full payload when nothing matches.
export function extractMintAddress(event) {
  if (!event || typeof event !== 'object') return null;
  for (const key of ['mint', 'ca', 'token', 'mint_address', 'tokenAddress', 'address']) {
    const val = event[key];
    if (typeof val === 'string' && val.length >= 32) return val;
  }
  console.warn('Unrecognized mint address in migration event, full payload:', event);
  return null;
}
