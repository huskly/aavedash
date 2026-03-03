import { STABLECOIN_CONTRACTS } from './constants.js';

const BALANCE_OF_SELECTOR = '0x70a08231';

function padAddress(address: string): string {
  return address.toLowerCase().replace('0x', '').padStart(64, '0');
}

function hexToNumber(hex: string, decimals: number): number {
  const raw = BigInt(hex);
  return Number(raw) / 10 ** decimals;
}

export async function fetchStablecoinBalances(
  wallet: string,
  rpcUrl: string,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  const entries = Object.entries(STABLECOIN_CONTRACTS);
  const paddedWallet = padAddress(wallet);

  const batchPayload = entries.map(([, { address }], index) => ({
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

  // Sort by id to match original order
  data.sort((a, b) => a.id - b.id);

  for (let i = 0; i < entries.length; i++) {
    const [symbol, { decimals }] = entries[i]!;
    const item = data[i];
    if (item?.result && item.result !== '0x') {
      const balance = hexToNumber(item.result, decimals);
      if (balance > 0) {
        results.set(symbol, balance);
      }
    }
  }

  return results;
}
