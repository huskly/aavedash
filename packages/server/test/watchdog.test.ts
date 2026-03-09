import assert from 'node:assert/strict';
import test from 'node:test';
import type { LoanPosition } from '@aave-monitor/core';
import { Watchdog } from '../src/watchdog.js';
import type { WatchdogConfig } from '../src/storage.js';
import type { TelegramClient } from '../src/telegram.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const RESCUE_CONTRACT = '0x2222222222222222222222222222222222222222';

function createConfig(overrides: Partial<WatchdogConfig> = {}): WatchdogConfig {
  return {
    enabled: true,
    dryRun: false,
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

function createLoan(): LoanPosition {
  return {
    id: 'loan-1',
    marketName: 'proto_mainnet_v3',
    borrowed: {
      symbol: 'USDC',
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
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
        address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
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

test('dry-run logs planned atomic rescue and applies cooldown', async () => {
  const { watchdog, messages } = createWatchdog(createConfig({ dryRun: true }));
  const targetHFWad = 1_900_000_000_000_000_000n;

  (watchdog as unknown as { getTokenBalance: () => Promise<bigint> }).getTokenBalance = async () =>
    100_000_000n;
  (
    watchdog as unknown as {
      getTokenAllowance: () => Promise<bigint>;
    }
  ).getTokenAllowance = async () => 100_000_000n;
  (
    watchdog as unknown as {
      findRequiredAmountRaw: () => Promise<bigint | null>;
    }
  ).findRequiredAmountRaw = async () => 2_500_000n;
  (
    watchdog as unknown as {
      previewResultingHF: () => Promise<bigint>;
    }
  ).previewResultingHF = async (
    _provider: unknown,
    _contract: string,
    _user: string,
    amount: bigint,
  ) => (amount > 0n ? targetHFWad : 1_500_000_000_000_000_000n);

  await watchdog.evaluate(createLoan(), WALLET);

  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /Watchdog DRY RUN/);
  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'dry-run');
  assert.equal(log[0]?.topUpWbtc, 0.025);
});

test('live mode skips when private key is missing', async () => {
  const { watchdog } = createWatchdog(createConfig({ dryRun: false }), { privateKey: null });

  (watchdog as unknown as { getTokenBalance: () => Promise<bigint> }).getTokenBalance = async () =>
    100_000_000n;
  (
    watchdog as unknown as {
      getTokenAllowance: () => Promise<bigint>;
    }
  ).getTokenAllowance = async () => 100_000_000n;
  (
    watchdog as unknown as {
      findRequiredAmountRaw: () => Promise<bigint | null>;
    }
  ).findRequiredAmountRaw = async () => 1_000_000n;
  (
    watchdog as unknown as {
      previewResultingHF: () => Promise<bigint>;
    }
  ).previewResultingHF = async () => 1_900_000_000_000_000_000n;

  await watchdog.evaluate(createLoan(), WALLET);

  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'skipped');
  assert.match(log[0]?.reason ?? '', /No private key configured/);
});

test('live mode executes rescue and records tx hash', async () => {
  const { watchdog, messages } = createWatchdog(createConfig({ dryRun: false }));

  (watchdog as unknown as { getTokenBalance: () => Promise<bigint> }).getTokenBalance = async () =>
    100_000_000n;
  (
    watchdog as unknown as {
      getTokenAllowance: () => Promise<bigint>;
    }
  ).getTokenAllowance = async () => 100_000_000n;
  (
    watchdog as unknown as {
      findRequiredAmountRaw: () => Promise<bigint | null>;
    }
  ).findRequiredAmountRaw = async () => 1_000_000n;
  (
    watchdog as unknown as {
      previewResultingHF: () => Promise<bigint>;
    }
  ).previewResultingHF = async () => 1_900_000_000_000_000_000n;
  (
    watchdog as unknown as {
      getGasPriceGwei: () => Promise<number>;
    }
  ).getGasPriceGwei = async () => 10;
  (watchdog as unknown as { getEthBalance: () => Promise<number> }).getEthBalance = async () => 1;
  (
    watchdog as unknown as {
      submitRescueTransaction: () => Promise<string>;
    }
  ).submitRescueTransaction = async () => '0xabc123';

  await watchdog.evaluate(createLoan(), WALLET);

  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'rescue');
  assert.equal(log[0]?.txHash, '0xabc123');
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /Atomic rescue executed/);
});

test('cooldown prevents immediate re-execution', async () => {
  const { watchdog } = createWatchdog(createConfig({ dryRun: true }));

  (watchdog as unknown as { getTokenBalance: () => Promise<bigint> }).getTokenBalance = async () =>
    100_000_000n;
  (
    watchdog as unknown as {
      getTokenAllowance: () => Promise<bigint>;
    }
  ).getTokenAllowance = async () => 100_000_000n;
  (
    watchdog as unknown as {
      findRequiredAmountRaw: () => Promise<bigint | null>;
    }
  ).findRequiredAmountRaw = async () => 1_000_000n;
  (
    watchdog as unknown as {
      previewResultingHF: () => Promise<bigint>;
    }
  ).previewResultingHF = async () => 1_900_000_000_000_000_000n;

  await watchdog.evaluate(createLoan(), WALLET);
  await watchdog.evaluate(createLoan(), WALLET);

  const log = watchdog.getLog();
  assert.equal(log.length, 2);
  assert.equal(log[0]?.action, 'skipped');
  assert.match(log[0]?.reason ?? '', /Cooldown active/);
});

test('invalid rescue contract produces skipped log entry', async () => {
  const { watchdog } = createWatchdog(createConfig({ rescueContract: '' }));

  await watchdog.evaluate(createLoan(), WALLET);

  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'skipped');
  assert.match(log[0]?.reason ?? '', /Invalid or missing rescueContract/);
});
