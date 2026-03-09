import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { Interface, parseUnits } from 'ethers';
import type { LoanPosition } from '@aave-monitor/core';
import { Watchdog } from '../src/watchdog.js';
import type { WatchdogConfig } from '../src/storage.js';
import type { TelegramClient } from '../src/telegram.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const RESCUE_CONTRACT = '0x2222222222222222222222222222222222222222';
const WBTC_CONTRACT = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';

const ERC20_INTERFACE = new Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const RESCUE_INTERFACE = new Interface([
  'function rescue((address user,address asset,uint256 amount,uint256 minResultingHF,uint256 deadline) params)',
  'function previewResultingHF(address user, address asset, uint256 amount) view returns (uint256)',
]);

function createConfig(overrides: Partial<WatchdogConfig> = {}): WatchdogConfig {
  return {
    enabled: true,
    dryRun: true,
    triggerHF: 1.65,
    targetHF: 1.9,
    minResultingHF: 1.85,
    cooldownMs: 30 * 60 * 1000,
    maxTopUpWbtc: 0.5,
    deadlineSeconds: 300,
    rescueContract: RESCUE_CONTRACT,
    maxGasGwei: 50,
    ...overrides,
  };
}

function createLoan(overrides: Partial<LoanPosition> = {}): LoanPosition {
  // Default loan: HF = 3200 * 0.75 / 1600 = 1.5 (below triggerHF=1.65)
  return {
    id: 'loan-1',
    marketName: 'proto_mainnet_v3',
    borrowed: {
      symbol: 'USDC',
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      decimals: 6,
      amount: 1600,
      usdPrice: 1,
      usdValue: 1600,
      collateralEnabled: false,
      maxLTV: 0,
      liqThreshold: 0,
      supplyRate: 0,
      borrowRate: 0.05,
    },
    supplied: [
      {
        symbol: 'WBTC',
        address: WBTC_CONTRACT,
        decimals: 8,
        amount: 0.08,
        usdPrice: 40_000,
        usdValue: 3_200,
        collateralEnabled: true,
        maxLTV: 0.7,
        liqThreshold: 0.75,
        supplyRate: 0,
        borrowRate: 0,
      },
    ],
    totalSuppliedUsd: 3_200,
    totalBorrowedUsd: 1_600,
    ...overrides,
  };
}

/**
 * Create a fake provider that intercepts eth_call and responds based on the
 * ABI-encoded function selector in the data payload.
 */
function createMockProvider(opts: {
  wbtcBalance: bigint;
  wbtcAllowance: bigint;
  /** Maps amount (bigint) to resulting HF (bigint, in 1e18 wad) */
  previewHF: (amount: bigint) => bigint;
  gasPriceGwei?: number;
  ethBalance?: number;
}) {
  const balanceOfSelector = ERC20_INTERFACE.getFunction('balanceOf')!.selector;
  const allowanceSelector = ERC20_INTERFACE.getFunction('allowance')!.selector;
  const previewSelector = RESCUE_INTERFACE.getFunction('previewResultingHF')!.selector;

  return {
    call: async (tx: { to: string; data: string }) => {
      const selector = tx.data.slice(0, 10);

      if (tx.to.toLowerCase() === WBTC_CONTRACT.toLowerCase()) {
        if (selector === balanceOfSelector) {
          return ERC20_INTERFACE.encodeFunctionResult('balanceOf', [opts.wbtcBalance]);
        }
        if (selector === allowanceSelector) {
          return ERC20_INTERFACE.encodeFunctionResult('allowance', [opts.wbtcAllowance]);
        }
      }

      if (tx.to.toLowerCase() === RESCUE_CONTRACT.toLowerCase() && selector === previewSelector) {
        const decoded = RESCUE_INTERFACE.decodeFunctionData('previewResultingHF', tx.data);
        const amount = BigInt(decoded[2]);
        return RESCUE_INTERFACE.encodeFunctionResult('previewResultingHF', [
          opts.previewHF(amount),
        ]);
      }

      throw new Error(`Unexpected call: to=${tx.to} selector=${selector}`);
    },
    getFeeData: async () => ({
      gasPrice: BigInt(Math.round((opts.gasPriceGwei ?? 10) * 1e9)),
    }),
    getBalance: async () => BigInt(Math.round((opts.ethBalance ?? 1) * 1e18)),
  };
}

function createWatchdog(
  config: WatchdogConfig,
  options: { privateKey?: string | null; chatId?: string | null } = {},
): { watchdog: Watchdog; messages: string[] } {
  const messages: string[] = [];
  const telegram = {
    async sendMessage(_chatId: string, text: string): Promise<boolean> {
      messages.push(text);
      return true;
    },
  } as unknown as TelegramClient;

  return {
    watchdog: new Watchdog(
      telegram,
      () => options.chatId ?? '123',
      () => config,
      'http://localhost:8545',
      options.privateKey === undefined ? '0xabc' : (options.privateKey ?? undefined),
    ),
    messages,
  };
}

function injectProvider(watchdog: Watchdog, provider: ReturnType<typeof createMockProvider>) {
  // Inject the mock provider so evaluate() uses it instead of creating a real one
  (watchdog as unknown as { provider: unknown }).provider = provider;
}

// ─── findRequiredAmountRaw integration tests ────────────────────────────────

describe('findRequiredAmountRaw (via evaluate)', () => {
  test('interpolates correct WBTC amount for target HF', async () => {
    const currentHFWad = parseUnits('1.5', 18); // HF at amount=0
    const maxTopUp = parseUnits('0.5', 8); // 0.5 WBTC = 50_000_000 sats

    // Linear model: HF(a) = 1.5 + (2.1 - 1.5) * (a / maxTopUp) = 1.5 + 0.6 * a/maxTopUp
    // For targetHF=1.9: a = maxTopUp * (1.9 - 1.5) / (2.1 - 1.5) = maxTopUp * 2/3
    const maxHFWad = parseUnits('2.1', 18);
    const slope = maxHFWad - currentHFWad; // 0.6e18

    const provider = createMockProvider({
      wbtcBalance: maxTopUp,
      wbtcAllowance: maxTopUp,
      previewHF: (amount: bigint) => {
        if (amount === 0n) return currentHFWad;
        // Linear: currentHF + slope * amount / maxTopUp
        return currentHFWad + (slope * amount) / maxTopUp;
      },
    });

    const { watchdog } = createWatchdog(createConfig({ dryRun: true }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log.length, 1);
    assert.equal(log[0]?.action, 'dry-run');

    // Expected: ~0.33333334 WBTC (2/3 of 0.5, +1 sat for round-up)
    const topUp = log[0]!.topUpWbtc;
    assert.ok(topUp > 0.333, `Expected ~0.333 WBTC, got ${topUp}`);
    assert.ok(topUp < 0.34, `Expected ~0.333 WBTC, got ${topUp}`);

    // Projected HF should be >= targetHF (1.9)
    assert.ok(log[0]!.projectedHF >= 1.9, `Projected HF ${log[0]!.projectedHF} < 1.9`);
  });

  test('falls back to minResultingHF when targetHF is unreachable', async () => {
    const currentHFWad = parseUnits('1.5', 18);
    const maxTopUp = parseUnits('0.1', 8); // only 0.1 WBTC available

    // With 0.1 WBTC max, HF only reaches 1.8 — below targetHF=1.9 but above minResultingHF=1.85?
    // Actually we need: max HF with full amount < targetHF(1.9), but max HF >= minResultingHF(1.85)
    const maxHFWad = parseUnits('1.88', 18); // can't reach 1.9, but can reach 1.85

    const provider = createMockProvider({
      wbtcBalance: maxTopUp,
      wbtcAllowance: maxTopUp,
      previewHF: (amount: bigint) => {
        if (amount === 0n) return currentHFWad;
        const slope = maxHFWad - currentHFWad; // 0.38e18
        return currentHFWad + (slope * amount) / maxTopUp;
      },
    });

    const { watchdog } = createWatchdog(createConfig({ dryRun: true }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log.length, 1);
    assert.equal(log[0]?.action, 'dry-run');

    // Should have used minResultingHF=1.85 as fallback target
    // amount = maxTopUp * (1.85 - 1.5) / (1.88 - 1.5) = maxTopUp * 0.35/0.38 ≈ 0.0921 WBTC
    const topUp = log[0]!.topUpWbtc;
    assert.ok(topUp > 0.09, `Expected ~0.092 WBTC, got ${topUp}`);
    assert.ok(topUp < 0.1, `Expected ~0.092 WBTC, got ${topUp}`);
  });

  test('skips when even maxAmount cannot reach minResultingHF', async () => {
    const currentHFWad = parseUnits('1.5', 18);
    const maxTopUp = parseUnits('0.01', 8); // tiny amount

    // Even full 0.01 WBTC only reaches 1.52 — way below minResultingHF=1.85
    const provider = createMockProvider({
      wbtcBalance: maxTopUp,
      wbtcAllowance: maxTopUp,
      previewHF: (amount: bigint) => {
        if (amount === 0n) return currentHFWad;
        const maxHFWad = parseUnits('1.52', 18);
        const slope = maxHFWad - currentHFWad;
        return currentHFWad + (slope * amount) / maxTopUp;
      },
    });

    const { watchdog, messages } = createWatchdog(createConfig({ dryRun: true }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log.length, 1);
    assert.equal(log[0]?.action, 'skipped');
    assert.match(log[0]?.reason ?? '', /Insufficient WBTC to achieve minimum resulting HF/);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /Rescue not feasible/);
  });

  test('skips with 0 amount when on-chain HF already meets target', async () => {
    const currentHFWad = parseUnits('2.0', 18); // already above targetHF=1.9
    const maxTopUp = parseUnits('0.5', 8);

    const provider = createMockProvider({
      wbtcBalance: maxTopUp,
      wbtcAllowance: maxTopUp,
      previewHF: (amount: bigint) => {
        if (amount === 0n) return currentHFWad;
        return currentHFWad + (parseUnits('0.5', 18) * amount) / maxTopUp;
      },
    });

    // Loan-level HF < triggerHF so evaluate doesn't exit early,
    // but on-chain previewResultingHF(0) already exceeds target.
    // findRequiredAmountRaw returns 0n → evaluate treats as "insufficient" and skips.
    const { watchdog } = createWatchdog(createConfig({ dryRun: true }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log.length, 1);
    assert.equal(log[0]?.action, 'skipped');
    assert.match(log[0]?.reason ?? '', /Insufficient WBTC/);
  });
});

// ─── Full evaluate integration tests with mock provider ─────────────────────

describe('evaluate integration with mock provider', () => {
  test('skips when WBTC balance is zero', async () => {
    const provider = createMockProvider({
      wbtcBalance: 0n,
      wbtcAllowance: parseUnits('1', 8),
      previewHF: () => parseUnits('1.5', 18),
    });

    const { watchdog, messages } = createWatchdog(createConfig({ dryRun: true }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log[0]?.action, 'skipped');
    assert.match(log[0]?.reason ?? '', /No available WBTC/);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /WBTC unavailable/);
  });

  test('skips when WBTC allowance is zero', async () => {
    const provider = createMockProvider({
      wbtcBalance: parseUnits('1', 8),
      wbtcAllowance: 0n,
      previewHF: () => parseUnits('1.5', 18),
    });

    const { watchdog, messages } = createWatchdog(createConfig({ dryRun: true }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log[0]?.action, 'skipped');
    assert.match(log[0]?.reason ?? '', /No available WBTC/);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /WBTC unavailable/);
  });

  test('uses min of balance, allowance, and maxTopUp as available amount', async () => {
    const balance = parseUnits('0.3', 8); // 30_000_000 sats — this is the limiting factor
    const allowance = parseUnits('1.0', 8); // 100_000_000 sats
    const currentHFWad = parseUnits('1.5', 18);

    // With balance as limit (0.3 WBTC), max achievable HF = 2.1
    const maxHFAtBalance = parseUnits('2.1', 18);

    const provider = createMockProvider({
      wbtcBalance: balance,
      wbtcAllowance: allowance,
      previewHF: (amount: bigint) => {
        if (amount === 0n) return currentHFWad;
        // Linear: 1.5 + 0.6 * amount / 0.3_WBTC
        const slope = maxHFAtBalance - currentHFWad;
        return currentHFWad + (slope * amount) / balance;
      },
    });

    const { watchdog } = createWatchdog(createConfig({ dryRun: true, maxTopUpWbtc: 0.5 }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log[0]?.action, 'dry-run');

    // amount = balance * (1.9 - 1.5) / (2.1 - 1.5) = 0.3 * 2/3 = 0.2 WBTC
    const topUp = log[0]!.topUpWbtc;
    assert.ok(topUp > 0.19, `Expected ~0.2 WBTC, got ${topUp}`);
    assert.ok(topUp < 0.21, `Expected ~0.2 WBTC, got ${topUp}`);
  });

  test('skips when projected HF is below minResultingHF', async () => {
    // Simulate non-linear reality: findRequiredAmountRaw succeeds (linear model
    // predicts target is reachable), but the final previewResultingHF call in
    // evaluate() returns below minHFWad.
    //
    // Call sequence in evaluate():
    //   findRequiredAmountRaw for targetHF:
    //     1. previewHF(0) = 1.5          — currentHF
    //     2. previewHF(maxAmount) = 2.1   — maxHF (optimistic linear model)
    //     3. previewHF(interpolated) = 1.9 — verification (passes targetHF check)
    //   Then evaluate() calls previewHF(interpolated) again for final check:
    //     4. previewHF(interpolated) = 1.8 — now non-linear reality, below minResultingHF
    const maxTopUp = parseUnits('0.5', 8);
    const currentHFWad = parseUnits('1.5', 18);
    let previewCallCount = 0;

    const provider = createMockProvider({
      wbtcBalance: maxTopUp,
      wbtcAllowance: maxTopUp,
      previewHF: (amount: bigint) => {
        previewCallCount++;
        if (amount === 0n) return currentHFWad;
        if (amount === maxTopUp) return parseUnits('2.1', 18);
        // Call 3 = verification inside findRequiredAmountRaw → return value that passes
        if (previewCallCount <= 3) return parseUnits('1.9', 18);
        // Call 4 = final check in evaluate() → return low value (non-linear reality)
        return parseUnits('1.8', 18);
      },
    });

    const { watchdog } = createWatchdog(createConfig({ dryRun: true }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log[0]?.action, 'skipped');
    assert.match(log[0]?.reason ?? '', /Projected HF below minimum/);
  });

  test('live mode skips when gas price exceeds max', async () => {
    const maxTopUp = parseUnits('0.5', 8);
    const currentHFWad = parseUnits('1.5', 18);

    const provider = createMockProvider({
      wbtcBalance: maxTopUp,
      wbtcAllowance: maxTopUp,
      previewHF: (amount: bigint) => {
        if (amount === 0n) return currentHFWad;
        return parseUnits('2.0', 18);
      },
      gasPriceGwei: 100, // exceeds maxGasGwei=50
      ethBalance: 1,
    });

    const { watchdog, messages } = createWatchdog(createConfig({ dryRun: false }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log[0]?.action, 'skipped');
    assert.match(log[0]?.reason ?? '', /Gas price.*exceeds max/);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /Gas too high/);
  });

  test('live mode skips when ETH balance is insufficient for gas', async () => {
    const maxTopUp = parseUnits('0.5', 8);
    const currentHFWad = parseUnits('1.5', 18);

    const provider = createMockProvider({
      wbtcBalance: maxTopUp,
      wbtcAllowance: maxTopUp,
      previewHF: (amount: bigint) => {
        if (amount === 0n) return currentHFWad;
        return parseUnits('2.0', 18);
      },
      gasPriceGwei: 10,
      ethBalance: 0.001, // below MIN_ETH_FOR_GAS = 0.005
    });

    const { watchdog, messages } = createWatchdog(createConfig({ dryRun: false }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log[0]?.action, 'skipped');
    assert.match(log[0]?.reason ?? '', /Insufficient ETH for gas/);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /Insufficient ETH for gas/);
  });

  test('does not trigger when HF is above triggerHF', async () => {
    // Loan with HF = 4800 * 0.75 / 1600 = 2.25 (above triggerHF=1.65)
    const healthyLoan = createLoan({
      supplied: [
        {
          symbol: 'WBTC',
          address: WBTC_CONTRACT,
          decimals: 8,
          amount: 0.12,
          usdPrice: 40_000,
          usdValue: 4_800,
          collateralEnabled: true,
          maxLTV: 0.7,
          liqThreshold: 0.75,
          supplyRate: 0,
          borrowRate: 0,
        },
      ],
      totalSuppliedUsd: 4_800,
    });

    const provider = createMockProvider({
      wbtcBalance: parseUnits('1', 8),
      wbtcAllowance: parseUnits('1', 8),
      previewHF: () => {
        throw new Error('Should not be called');
      },
    });

    const { watchdog } = createWatchdog(createConfig({ dryRun: true }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(healthyLoan, WALLET);

    // No log entries — evaluate returned early
    assert.equal(watchdog.getLog().length, 0);
  });

  test('does not trigger when watchdog is disabled', async () => {
    const provider = createMockProvider({
      wbtcBalance: parseUnits('1', 8),
      wbtcAllowance: parseUnits('1', 8),
      previewHF: () => {
        throw new Error('Should not be called');
      },
    });

    const { watchdog } = createWatchdog(createConfig({ enabled: false }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    assert.equal(watchdog.getLog().length, 0);
  });

  test('no notification sent when getChatId returns null', async () => {
    const maxTopUp = parseUnits('0.5', 8);

    const provider = createMockProvider({
      wbtcBalance: maxTopUp,
      wbtcAllowance: maxTopUp,
      previewHF: (amount: bigint) => {
        if (amount === 0n) return parseUnits('1.5', 18);
        return parseUnits('2.0', 18);
      },
    });

    const messages: string[] = [];
    const telegram = {
      async sendMessage(_chatId: string, text: string): Promise<boolean> {
        messages.push(text);
        return true;
      },
    } as unknown as TelegramClient;

    const watchdog = new Watchdog(
      telegram,
      () => null, // getChatId returns null
      () => createConfig({ dryRun: true }),
      'http://localhost:8545',
      '0xabc',
    );
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log[0]?.action, 'dry-run');
    // No messages sent since getChatId returns null
    assert.equal(messages.length, 0);
  });
});
