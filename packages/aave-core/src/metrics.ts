import type {
  AdjustedHFResult,
  AssetLiquidation,
  AssetPosition,
  BadgeTone,
  Computed,
  LoanPosition,
} from './types.js';

export function n(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value.replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function parseBalance(raw: string, decimals: number): number {
  const normalized = Number(raw) / 10 ** decimals;
  return Number.isFinite(normalized) ? normalized : 0;
}

export function fromBps(raw: string): number {
  return clamp(n(raw) / 10_000, 0, 0.99);
}

export function fromRay(raw: string): number {
  return Math.max(0, n(raw) / 10 ** 27);
}

export function weightedAverage(
  items: AssetPosition[],
  valueSelector: (item: AssetPosition) => number,
): number {
  const totalWeight = items.reduce((sum, item) => sum + item.usdValue, 0);
  if (totalWeight <= 0) return 0;

  const weighted = items.reduce((sum, item) => sum + valueSelector(item) * item.usdValue, 0);
  return weighted / totalWeight;
}

export function healthLabel(hf: number): { label: string; tone: BadgeTone } {
  if (!Number.isFinite(hf) || hf <= 0) return { label: 'Invalid', tone: 'danger' };
  if (hf < 1.1) return { label: 'Danger', tone: 'danger' };
  if (hf < 1.5) return { label: 'Tight', tone: 'warning' };
  if (hf < 2) return { label: 'OK', tone: 'neutral' };
  return { label: 'Safe', tone: 'positive' };
}

export function portfolioHealthFactorBand(hf: number): {
  guidance: string;
  valueClassName: string;
} {
  if (!Number.isFinite(hf) || hf <= 0) {
    return {
      guidance: 'Invalid reading',
      valueClassName: 'text-[#ef4444]',
    };
  }
  if (hf < 1.5) {
    return {
      guidance: 'Mandatory deleveraging',
      valueClassName: 'text-[#ef4444]',
    };
  }
  if (hf < 1.8) {
    return {
      guidance: 'Top up collateral or reduce debt',
      valueClassName: 'text-[#f59e0b]',
    };
  }
  if (hf <= 2.2) {
    return {
      guidance: 'No new leverage, monitor closely',
      valueClassName: 'text-[#84cc16]',
    };
  }
  return {
    guidance: 'Normal operation',
    valueClassName: 'text-[#22c55e]',
  };
}

export function parseDeployRate(value: string | undefined, defaultRate: number): number {
  if (!value) return defaultRate;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultRate;
}

export function computeAdjustedHF(loan: LoanPosition): AdjustedHFResult {
  const debt = loan.totalBorrowedUsd;
  const borrowedSymbol = loan.borrowed.symbol;

  const nonSameAssets = loan.supplied.filter((asset) => asset.symbol !== borrowedSymbol);
  const sameAssets = loan.supplied.filter((asset) => asset.symbol === borrowedSymbol);

  const adjustedCollateralUSD = nonSameAssets.reduce((sum, asset) => sum + asset.usdValue, 0);
  const adjustedLt = weightedAverage(nonSameAssets, (asset) => asset.liqThreshold);
  const sameAssetSuppliedUSD = sameAssets.reduce((sum, asset) => sum + asset.usdValue, 0);
  const sameAssetSuppliedAmount = sameAssets.reduce((sum, asset) => sum + asset.amount, 0);

  const adjustedHF =
    debt > 0 && adjustedCollateralUSD > 0
      ? (adjustedCollateralUSD * adjustedLt) / debt
      : debt > 0
        ? 0
        : Infinity;

  return {
    adjustedHF,
    adjustedCollateralUSD,
    adjustedLt,
    sameAssetSuppliedUSD,
    sameAssetSuppliedAmount,
    debt,
  };
}

export function computeLoanMetrics(loan: LoanPosition | null, rDeploy: number): Computed {
  if (!loan) {
    return {
      units: 0,
      px: 0,
      debt: 0,
      collateralUSD: 0,
      equity: 0,
      ltv: 0,
      leverage: 0,
      healthFactor: Infinity,
      liqPrice: Infinity,
      collateralUSDAtLiq: Infinity,
      ltvAtLiq: 0,
      priceDropToLiq: 0,
      supplyEarnUSD: 0,
      borrowCostUSD: 0,
      deployEarnUSD: 0,
      netEarnUSD: 0,
      netAPYOnEquity: 0,
      maxBorrowByLTV: 0,
      borrowHeadroom: 0,
      borrowPowerUsed: 0,
      equityMoveFor10Pct: 0,
      collateralBufferUSD: 0,
      adjustedHF: Infinity,
      alertHF: false,
      alertLTV: false,
      ltvMax: 0,
      lt: 0,
      rSupply: 0,
      rBorrow: 0,
      rDeploy: 0,
      primaryCollateralSymbol: '—',
      assetLiquidations: [],
    };
  }

  const debt = loan.totalBorrowedUsd;
  const collateralUSD = loan.totalSuppliedUsd;
  const equity = collateralUSD - debt;

  const ltvMax = weightedAverage(loan.supplied, (asset) => asset.maxLTV);
  const lt = weightedAverage(loan.supplied, (asset) => asset.liqThreshold);
  const rSupply = weightedAverage(loan.supplied, (asset) => asset.supplyRate);
  const rBorrow = loan.borrowed.borrowRate;

  const ltv = collateralUSD > 0 ? debt / collateralUSD : 0;
  const leverage = equity > 0 ? collateralUSD / equity : Infinity;
  const healthFactor = debt > 0 ? (collateralUSD * lt) / debt : Infinity;

  const primary =
    loan.supplied.length > 0
      ? loan.supplied.reduce((max, current) => (current.usdValue > max.usdValue ? current : max))
      : null;

  const units = primary?.amount ?? 0;
  const px = primary?.usdPrice ?? 0;
  const primaryCollateralSymbol = primary?.symbol ?? '—';

  const collateralUSDAtLiq = lt > 0 ? debt / lt : Infinity;
  const collateralOtherUSD = collateralUSD - (primary?.usdValue ?? 0);
  const primaryUsdAtLiq = collateralUSDAtLiq - collateralOtherUSD;
  const liqPrice = units > 0 ? Math.max(0, primaryUsdAtLiq / units) : Infinity;
  const ltvAtLiq = collateralUSDAtLiq > 0 ? debt / collateralUSDAtLiq : 0;
  const priceDropToLiq = px > 0 && Number.isFinite(liqPrice) ? (px - liqPrice) / px : 0;

  const supplyEarnUSD = collateralUSD * rSupply;
  const borrowCostUSD = debt * rBorrow;
  const deployEarnUSD = debt * rDeploy;

  const netEarnUSD = supplyEarnUSD - borrowCostUSD;
  const netAPYOnEquity = equity > 0 ? netEarnUSD / equity : 0;

  const maxBorrowByLTV = collateralUSD * ltvMax;
  const borrowHeadroom = maxBorrowByLTV - debt;
  const borrowPowerUsed = maxBorrowByLTV > 0 ? debt / maxBorrowByLTV : 0;

  const equityMoveFor10Pct = Number.isFinite(leverage) ? leverage * 0.1 : 0;
  const collateralBufferUSD = collateralUSD - collateralUSDAtLiq;

  const assetLiquidations: AssetLiquidation[] = loan.supplied.map((asset) => {
    const otherWeightedCollateral = loan.supplied.reduce(
      (sum, other) => (other === asset ? sum : sum + other.usdValue * other.liqThreshold),
      0,
    );
    const numerator = debt - otherWeightedCollateral;
    if (asset.amount <= 0 || asset.usdPrice <= 0) {
      return {
        symbol: asset.symbol,
        liqPrice: Infinity,
        priceDropToLiq: 1,
        currentPrice: asset.usdPrice,
      };
    }
    // If other collateral alone covers the debt, a single-asset drop can't trigger
    // liquidation. Fall back to proportional-drop price (assumes all assets decline equally).
    if (numerator <= 0 || asset.liqThreshold <= 0) {
      const proportionalLiqPrice =
        Number.isFinite(healthFactor) && healthFactor > 0
          ? asset.usdPrice / healthFactor
          : Infinity;
      const drop = Number.isFinite(proportionalLiqPrice)
        ? (asset.usdPrice - proportionalLiqPrice) / asset.usdPrice
        : 0;
      return {
        symbol: asset.symbol,
        liqPrice: proportionalLiqPrice,
        priceDropToLiq: Math.max(0, drop),
        currentPrice: asset.usdPrice,
      };
    }
    const liqPriceForAsset = numerator / (asset.liqThreshold * asset.amount);
    const drop = (asset.usdPrice - liqPriceForAsset) / asset.usdPrice;
    return {
      symbol: asset.symbol,
      liqPrice: liqPriceForAsset,
      priceDropToLiq: Math.max(0, drop),
      currentPrice: asset.usdPrice,
    };
  });

  const { adjustedHF } = computeAdjustedHF(loan);
  const alertHF = healthFactor < 1.5;
  const alertLTV = ltv > 0.7 * lt;

  return {
    units,
    px,
    debt,
    collateralUSD,
    equity,
    ltv,
    leverage,
    healthFactor,
    liqPrice,
    collateralUSDAtLiq,
    ltvAtLiq,
    priceDropToLiq,
    supplyEarnUSD,
    borrowCostUSD,
    deployEarnUSD,
    netEarnUSD,
    netAPYOnEquity,
    maxBorrowByLTV,
    borrowHeadroom,
    borrowPowerUsed,
    equityMoveFor10Pct,
    collateralBufferUSD,
    adjustedHF,
    alertHF,
    alertLTV,
    ltvMax,
    lt,
    rSupply,
    rBorrow,
    rDeploy,
    primaryCollateralSymbol,
    assetLiquidations,
  };
}
