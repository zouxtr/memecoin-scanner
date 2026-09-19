// Thresholds/weights ported 1:1 from config.py + scoring.py WEIGHTS.
// Do not change values here — mirror the Python backend.
export const CONFIG = {
  POLL_INTERVAL_SECONDS: 60,
  MONITOR_WINDOW_MINUTES: 45,
  MIN_POLLS_BEFORE_ALERT: 3,
  PEAK_DRAWDOWN_STOP_PCT: 10,
  FINAL_CHECK_MAX_DRAWDOWN_PCT: 8,
  MIN_LP_LOCKED_PCT: 50,
  BLOCK_ON_LOW_LIQUIDITY_RISK: true,
  MIN_LIQUIDITY_USD: 15000,
  MAX_INSIDER_CLUSTERS: 10,
  RUGCHECK_REFRESH_EVERY_N_POLLS: 2,
  MAX_MARKET_CAP_USD: 110000,
  EXTENDED_MAX_MARKET_CAP_USD: 500000,
  EXTENDED_ZONE_MIN_LIQUIDITY_USD: 40000,
  MAX_VOLUME_TO_LIQUIDITY_RATIO: 15,
  HIGH_POTENTIAL_THRESHOLD: 65,
  PUMPPORTAL_WS_URL: 'wss://pumpportal.fun/api/data',

  // --- Rug-pull DD (see js/rugSignals.js) ---
  // ruggedScore >= RUG_RISK_THRESHOLD hard-excludes a coin from "high
  // potential" notifications (still listed in the UI, tagged red).
  // 50 = any two major flags (e.g. mint+freeze authorities), or a
  // concentration + unlocked-LP + dev-holding combo. Single minor flags
  // (one holder at 9%, unknown LP status, ...) do not block alone.
  RUG_RISK_THRESHOLD: 50,
  // Flag if the largest non-LP holder owns more than this % of supply.
  TOP_HOLDER_PCT_THRESHOLD: 8,
  // Flag if the creator wallet itself holds more than this % post-migration.
  DEV_HOLDING_PCT_THRESHOLD: 5,
  // Public Solana RPC (no key) used ONLY as a best-effort fallback for the
  // holder list when the RugCheck report has no topHolders yet.
  SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
  SOLANA_RPC_MIN_SPACING_MS: 1500,
  SOLANA_RPC_MAX_RETRIES: 2,
  SOLANA_RPC_RETRY_BASE_MS: 2000,

  // --- Penny-stock scanner (see js/stocks.js / js/stockScoring.js) ---
  // Fully independent from the crypto constants above.
  STOCK_POLL_INTERVAL_SECONDS: 60,
  STOCK_MAX_PRICE: 5,
  STOCK_MOVERS_LIMIT: 20,
  STOCK_POTENTIAL_THRESHOLD: 65,
  STOCK_GAIN_WEIGHT_PER_PCT: 5, // 10% gain -> +50 (capped at 50)
  STOCK_RVOL_WEIGHT: 10,         // 2x relVol -> +10 (capped at 35)
  STOCK_MIN_CHANGE_PCT: 3,       // below this, never alert
};

export const WEIGHTS = {
  liquidity: 20,
  volume: 20,
  momentum: 30,
  no_mint_authority: 10,
  no_freeze_authority: 10,
  low_risk_flags: 10,
};

export const IMPERSONATION_KEYWORDS = (
  'elon,elonmusk,musk,spacex,neuralink,' +
  'trump,donaldtrump,maga,' +
  'biden,joebiden,kamala,kamalaharris,' +
  'obama,barackobama,putin,zelensky,zelenskyy,' +
  'kanye,yeezy,drake,kimkardashian,kardashian,' +
  'messi,ronaldo,neymar,' +
  'mrbeast,' +
  'bezos,jeffbezos,zuckerberg,markzuckerberg,gates,billgates,' +
  'buffett,warrenbuffett,cathiewood,sbf,sambankmanfried,' +
  'taylorswift,beyonce,rihanna,kimjongun,' +
  'vitalik,vitalikbuterin,buterin,satoshi,cz_binance,changpeng,zhao,' +
  'justinsun,tron'
).split(',');

export const IMPERSONATION_LEGITIMACY_WORDS = (
  'official,verified,genuine,authentic,foundation,realaccount,' +
  'confirmed,endorsed,ceo'
).split(',');
