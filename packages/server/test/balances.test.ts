import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchStablecoinBalances, fetchTokenBalances } from '@aave-monitor/core';

const WALLET = '0x1111111111111111111111111111111111111111';
const RPC_URL = 'http://localhost:8545';

test('fetchTokenBalances returns non-zero balances keyed by token key', async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(String(init?.body)) as Array<{ params: Array<{ to: string }> }>;
      assert.equal(body.length, 2);
      assert.equal(body[0]?.params[0]?.to, '0xaaaa000000000000000000000000000000000001');
      assert.equal(body[1]?.params[0]?.to, '0xbbbb000000000000000000000000000000000002');

      return new Response(
        JSON.stringify([
          { id: 1, result: '0x' },
          { id: 0, result: '0xde0b6b3a7640000' },
        ]),
        { status: 200 },
      );
    }) as typeof fetch;

    const balances = await fetchTokenBalances(WALLET, RPC_URL, [
      { key: 'weth', address: '0xaAaA000000000000000000000000000000000001', decimals: 18 },
      { key: 'wbtc', address: '0xbBbB000000000000000000000000000000000002', decimals: 8 },
    ]);

    assert.deepEqual(Object.fromEntries(balances), { weth: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchStablecoinBalances delegates through the generic token balance fetcher', async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify(
          Array.from({ length: 9 }, (_, index) => ({
            id: index,
            result: index === 0 ? '0x0f4240' : '0x',
          })),
        ),
        { status: 200 },
      )) as typeof fetch;

    const balances = await fetchStablecoinBalances(WALLET, RPC_URL);
    assert.deepEqual(Object.fromEntries(balances), { USDC: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
