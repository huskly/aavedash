import { STABLECOIN_CONTRACTS } from './constants.js';

const BALANCE_OF_SELECTOR = '0x70a08231';

export type TokenBalanceTarget = {
  key: string;
  address: string;
  decimals: number;
};

function padAddress(address: string): string {
  return address.toLowerCase().replace('0x', '').padStart(64, '0');
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function hexToNumber(hex: string, decimals: number): number {
  const raw = BigInt(hex);
  return Number(raw) / 10 ** decimals;
}

export async function fetchTokenBalances(
  wallet: string,
  rpcUrl: string,
  tokens: TokenBalanceTarget[],
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  const entries = tokens.map((token) => ({
    ...token,
    address: normalizeAddress(token.address),
  }));
  if (entries.length === 0) return results;

  const paddedWallet = padAddress(wallet);
  const batchPayload = entries.map(({ address }, index) => ({
    jsonrpc: '2.0' as const,
    id: index,
    method: 'eth_call',
    params: [{ to: address, data: `${BALANCE_OF_SELECTOR}${paddedWallet}` }, 'latest'],
  }));

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batchPayload),
  });

  if (!response.ok) {
    throw new Error(`RPC request failed: ${response.status}`);
  }

  const data = (await response.json()) as Array<{
    id: number;
    result?: string;
    error?: { message: string };
  }>;

  data.sort((a, b) => a.id - b.id);

  for (let i = 0; i < entries.length; i++) {
    const token = entries[i];
    const item = data[i];
    if (!token || !item?.result || item.result === '0x') continue;

    const balance = hexToNumber(item.result, token.decimals);
    if (balance > 0) {
      results.set(token.key, balance);
    }
  }

  return results;
}

export async function fetchStablecoinBalances(
  wallet: string,
  rpcUrl: string,
): Promise<Map<string, number>> {
  return fetchTokenBalances(
    wallet,
    rpcUrl,
    Object.entries(STABLECOIN_CONTRACTS).map(([symbol, token]) => ({
      key: symbol,
      address: token.address,
      decimals: token.decimals,
    })),
  );
}
