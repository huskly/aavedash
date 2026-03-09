export type BadgeTone = 'neutral' | 'positive' | 'warning' | 'danger';

export type PollingConfig = {
  intervalMs: number;
  debounceChecks: number;
  reminderIntervalMs: number;
  cooldownMs: number;
};

export type WatchdogConfig = {
  enabled: boolean;
  dryRun: boolean;
  triggerHF: number;
  targetHF: number;
  minResultingHF: number;
  cooldownMs: number;
  maxTopUpWbtc: number;
  deadlineSeconds: number;
  rescueContract: string;
  maxGasGwei: number;
};

export type RawUserReserve = {
  currentATokenBalance: string;
  currentTotalDebt: string;
  usageAsCollateralEnabledOnUser: boolean;
  reserve: {
    symbol: string;
    decimals: number;
    underlyingAsset: string;
    baseLTVasCollateral: string;
    reserveLiquidationThreshold: string;
    liquidityRate: string;
    variableBorrowRate: string;
  };
};

export type AssetPosition = {
  symbol: string;
  address: string;
  decimals: number;
  amount: number;
  usdPrice: number;
  usdValue: number;
  collateralEnabled: boolean;
  maxLTV: number;
  liqThreshold: number;
  supplyRate: number;
  borrowRate: number;
};

export type LoanPosition = {
  id: string;
  marketName: string;
  borrowed: AssetPosition;
  supplied: AssetPosition[];
  totalSuppliedUsd: number;
  totalBorrowedUsd: number;
};

export type RawUserReserveWithMarket = RawUserReserve & { __marketName: string };

export type FetchState = {
  wallet: string;
  loans: LoanPosition[];
  lastUpdated: string;
};

export type Computed = {
  units: number;
  px: number;
  debt: number;
  collateralUSD: number;
  equity: number;
  ltv: number;
  leverage: number;
  healthFactor: number;
  liqPrice: number;
  collateralUSDAtLiq: number;
  ltvAtLiq: number;
  priceDropToLiq: number;
  supplyEarnUSD: number;
  borrowCostUSD: number;
  deployEarnUSD: number;
  netEarnUSD: number;
  netAPYOnEquity: number;
  maxBorrowByLTV: number;
  borrowHeadroom: number;
  borrowPowerUsed: number;
  equityMoveFor10Pct: number;
  collateralBufferUSD: number;
  adjustedHF: number;
  alertHF: boolean;
  alertLTV: boolean;
  ltvMax: number;
  lt: number;
  rSupply: number;
  rBorrow: number;
  rDeploy: number;
  primaryCollateralSymbol: string;
  assetLiquidations: AssetLiquidation[];
};

export type AssetLiquidation = {
  symbol: string;
  liqPrice: number;
  priceDropToLiq: number;
  currentPrice: number;
};

export type AdjustedHFResult = {
  adjustedHF: number;
  adjustedCollateralUSD: number;
  adjustedLt: number;
  sameAssetSuppliedUSD: number;
  sameAssetSuppliedAmount: number;
  debt: number;
};

export type AaveMarket = {
  readonly marketName: string;
  readonly graphSubgraphId: string;
  readonly fallbackEndpoints: readonly string[];
};
