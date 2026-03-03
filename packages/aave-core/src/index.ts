export type {
  AaveMarket,
  AssetPosition,
  BadgeTone,
  Computed,
  FetchState,
  LoanPosition,
  RawUserReserve,
  RawUserReserveWithMarket,
} from './types.js';

export {
  AAVE_MARKETS,
  COINGECKO_IDS_BY_SYMBOL,
  DEFAULT_R_DEPLOY,
  ETHEREUM_ADDRESS_REGEX,
  STABLECOIN_CONTRACTS,
  STABLECOIN_SYMBOLS,
  USER_RESERVES_QUERY,
} from './constants.js';

export { fetchStablecoinBalances } from './balances.js';

export {
  clamp,
  computeLoanMetrics,
  fromBps,
  fromRay,
  healthLabel,
  n,
  parseBalance,
  parseDeployRate,
  portfolioHealthFactorBand,
  weightedAverage,
} from './metrics.js';

export { buildLoanPositions, fetchFromAaveSubgraph } from './aave.js';

export { fetchUsdPrices } from './prices.js';

export {
  classifyZone,
  DEFAULT_ZONES,
  isImproving,
  isWorsening,
  type Zone,
  type ZoneName,
} from './zones.js';
