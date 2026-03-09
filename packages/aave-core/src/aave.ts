import { AAVE_MARKETS, USER_RESERVES_QUERY } from './constants.js';
import { fromBps, fromRay, parseBalance } from './metrics.js';
import type {
  AssetPosition,
  LoanPosition,
  RawUserReserve,
  RawUserReserveWithMarket,
} from './types.js';

const MIN_POSITION_USD = 0.01;

export async function fetchFromAaveSubgraph(
  wallet: string,
  graphApiKey: string | undefined,
): Promise<RawUserReserveWithMarket[]> {
  const marketResults = await Promise.all(
    AAVE_MARKETS.map(async (market) => {
      const graphGatewayEndpoint = graphApiKey
        ? `https://gateway-arbitrum.network.thegraph.com/api/${graphApiKey}/subgraphs/id/${market.graphSubgraphId}`
        : null;

      const endpoints = [
        ...(graphGatewayEndpoint ? [graphGatewayEndpoint] : []),
        ...market.fallbackEndpoints,
      ];
      const failures: string[] = [];
      let sawHostedServiceRemoval = false;

      if (endpoints.length === 0) {
        return {
          marketName: market.marketName,
          reserves: [] as RawUserReserve[],
          failures: ['No endpoint configured (set VITE_THE_GRAPH_API_KEY).'],
          sawHostedServiceRemoval: false,
        };
      }

      for (const endpoint of endpoints) {
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              query: USER_RESERVES_QUERY,
              variables: { user: wallet.toLowerCase() },
            }),
          });

          if (!response.ok) {
            failures.push(`${endpoint} (${response.status})`);
            continue;
          }

          const payload = (await response.json()) as {
            data?: { userReserves?: RawUserReserve[] };
            errors?: Array<{ message: string }>;
          };

          if (payload.errors?.length) {
            if (
              payload.errors.some((entry) =>
                entry.message.toLowerCase().includes('endpoint has been removed'),
              )
            ) {
              sawHostedServiceRemoval = true;
            }
            failures.push(`${endpoint} (GraphQL error)`);
            continue;
          }

          return {
            marketName: market.marketName,
            reserves: payload.data?.userReserves ?? [],
            failures: [] as string[],
            sawHostedServiceRemoval: false,
          };
        } catch {
          failures.push(`${endpoint} (network)`);
        }
      }

      return {
        marketName: market.marketName,
        reserves: [] as RawUserReserve[],
        failures,
        sawHostedServiceRemoval,
      };
    }),
  );

  const successfulResults = marketResults.filter((result) => result.failures.length === 0);
  if (successfulResults.length > 0) {
    return successfulResults.flatMap((result) =>
      result.reserves.map((reserve) => ({ ...reserve, __marketName: result.marketName })),
    );
  }

  const sawHostedServiceRemoval = marketResults.some((result) => result.sawHostedServiceRemoval);
  if (!graphApiKey && sawHostedServiceRemoval) {
    throw new Error(
      'Aave subgraph hosted-service endpoints were deprecated. Set VITE_THE_GRAPH_API_KEY in your .env (The Graph API key) and restart the dev server.',
    );
  }

  const failureText = marketResults
    .map((result) => `${result.marketName}: ${result.failures.join(', ')}`)
    .join(' | ');
  throw new Error(
    `Unable to fetch Aave user reserves from public endpoints. Tried: ${failureText}`,
  );
}

function toAssetPosition(
  raw: RawUserReserve,
  amount: number,
  prices: Map<string, number>,
): AssetPosition {
  const address = raw.reserve.underlyingAsset.toLowerCase();
  const symbol = raw.reserve.symbol.toUpperCase();
  const usdPrice = prices.get(symbol) ?? 0;

  return {
    symbol,
    address,
    decimals: raw.reserve.decimals,
    amount,
    usdPrice,
    usdValue: amount * usdPrice,
    collateralEnabled: raw.usageAsCollateralEnabledOnUser,
    maxLTV: fromBps(raw.reserve.baseLTVasCollateral),
    liqThreshold: fromBps(raw.reserve.reserveLiquidationThreshold),
    supplyRate: fromRay(raw.reserve.liquidityRate),
    borrowRate: fromRay(raw.reserve.variableBorrowRate),
  };
}

export function buildLoanPositions(
  reserves: RawUserReserveWithMarket[],
  prices: Map<string, number>,
): LoanPosition[] {
  const loansByMarket = new Map<string, RawUserReserveWithMarket[]>();

  reserves.forEach((reserve) => {
    const group = loansByMarket.get(reserve.__marketName) ?? [];
    group.push(reserve);
    loansByMarket.set(reserve.__marketName, group);
  });

  return Array.from(loansByMarket.entries()).flatMap(([marketName, marketReserves]) => {
    const suppliedAssets = marketReserves
      .map((entry) => {
        const amount = parseBalance(entry.currentATokenBalance, entry.reserve.decimals);
        return toAssetPosition(entry, amount, prices);
      })
      .filter((entry) => entry.amount > 0);

    const borrowedAssets = marketReserves
      .map((entry) => {
        const amount = parseBalance(entry.currentTotalDebt, entry.reserve.decimals);
        return toAssetPosition(entry, amount, prices);
      })
      .filter((entry) => entry.amount > 0);

    const collateralSupplies = suppliedAssets.filter((asset) => asset.collateralEnabled);

    return borrowedAssets
      .map((borrowed, index) => ({
        id: `${marketName}-${borrowed.address}-${index}`,
        marketName,
        borrowed,
        supplied: collateralSupplies,
        totalBorrowedUsd: borrowed.usdValue,
        totalSuppliedUsd: collateralSupplies.reduce((sum, asset) => sum + asset.usdValue, 0),
      }))
      .filter(
        (loan) =>
          loan.totalBorrowedUsd >= MIN_POSITION_USD || loan.totalSuppliedUsd >= MIN_POSITION_USD,
      );
  });
}
