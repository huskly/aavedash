import type { AaveMarket } from './types.js';

export const AAVE_MARKETS: readonly AaveMarket[] = [
  {
    marketName: 'proto_mainnet_v3',
    graphSubgraphId: 'Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g',
    fallbackEndpoints: ['https://api.thegraph.com/subgraphs/name/aave/protocol-v3'],
  },
  {
    marketName: 'proto_lido_v3',
    graphSubgraphId: '5vxMbXRhG1oQr55MWC5j6qg78waWujx1wjeuEWDA6j3',
    fallbackEndpoints: [],
  },
] as const;

export const COINGECKO_IDS_BY_SYMBOL: Record<string, string> = {
  ETH: 'ethereum',
  WETH: 'weth',
  WBTC: 'wrapped-bitcoin',
  USDC: 'usd-coin',
  USDT: 'tether',
  DAI: 'dai',
  LDO: 'lido-dao',
  LINK: 'chainlink',
  AAVE: 'aave',
  CRV: 'curve-dao-token',
  MKR: 'maker',
  UNI: 'uniswap',
  SNX: 'havven',
  BAL: 'balancer',
};

export const USER_RESERVES_QUERY = `
  query UserReserves($user: String!) {
    userReserves(first: 200, where: { user: $user }) {
      currentATokenBalance
      currentTotalDebt
      usageAsCollateralEnabledOnUser
      reserve {
        symbol
        decimals
        underlyingAsset
        baseLTVasCollateral
        reserveLiquidationThreshold
        liquidityRate
        variableBorrowRate
      }
    }
  }
`;

export const STABLECOIN_SYMBOLS: Set<string> = new Set([
  'USDC',
  'USDT',
  'DAI',
  'USDS',
  'GHO',
  'LUSD',
  'FRAX',
  'PYUSD',
  'crvUSD',
]);

export const STABLECOIN_CONTRACTS: Record<string, { address: string; decimals: number }> = {
  USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
  DAI: { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
  USDS: { address: '0xdC035D45d973E3EC169d2276DDab16f1e407384F', decimals: 18 },
  GHO: { address: '0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f', decimals: 18 },
  LUSD: { address: '0x5f98805A4E8be255a32880FDeC7F6728C6568bA0', decimals: 18 },
  FRAX: { address: '0x853d955aCEf822Db058eb8505911ED77F175b99e', decimals: 18 },
  PYUSD: { address: '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8', decimals: 6 },
  crvUSD: { address: '0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E', decimals: 18 },
};

export const DEFAULT_R_DEPLOY = 0.1125;

export const ETHEREUM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
