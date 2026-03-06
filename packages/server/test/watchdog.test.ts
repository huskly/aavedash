import assert from 'node:assert/strict';
import test from 'node:test';
import type { LoanPosition } from '@aave-monitor/core';
import { Watchdog } from '../src/watchdog.js';
import type { WatchdogConfig } from '../src/storage.js';
import type { TelegramClient } from '../src/telegram.js';

const WALLET = '0x1111111111111111111111111111111111111111';

function createConfig(overrides: Partial<WatchdogConfig> = {}): WatchdogConfig {
  return {
    enabled: true,
    dryRun: false,
    triggerHF: 1.25,
    targetHF: 1.5,
    cooldownMs: 30 * 60 * 1000,
    maxRepayUsd: 10_000,
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
      amount: 1_000,
      usdPrice: 1,
      usdValue: 1_000,
      collateralEnabled: false,
      maxLTV: 0,
      liqThreshold: 0,
      supplyRate: 0,
      borrowRate: 0.05,
    },
    supplied: [
      {
        symbol: 'WETH',
        address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        amount: 1,
        usdPrice: 1_000,
        usdValue: 1_000,
        collateralEnabled: true,
        maxLTV: 0.8,
        liqThreshold: 0.8,
        supplyRate: 0.01,
        borrowRate: 0,
      },
    ],
    totalSuppliedUsd: 1_000,
    totalBorrowedUsd: 1_000,
  };
}

function createWatchdog(config: WatchdogConfig): Watchdog {
  const telegram = {
    async sendMessage(): Promise<boolean> {
      return true;
    },
  } as unknown as TelegramClient;
  return new Watchdog(
    telegram,
    () => '123',
    () => config,
    'http://localhost:8545',
    '0xabc',
  );
}

test('does not mutate wallet balance or set cooldown when live execution is skipped', async () => {
  const watchdog = createWatchdog(createConfig());
  const balances = new Map<string, number>([['USDC', 1_000]]);

  (watchdog as unknown as { executeRepay: () => Promise<{ status: 'skipped' }> }).executeRepay =
    async () => ({ status: 'skipped' });

  await watchdog.evaluate(createLoan(), WALLET, balances);

  assert.equal(balances.get('USDC'), 1_000);
  const cooldowns = (watchdog as unknown as { cooldowns: Map<string, number> }).cooldowns;
  assert.equal(cooldowns.size, 0);
});

test('mutates wallet balance and sets cooldown when live execution succeeds', async () => {
  const watchdog = createWatchdog(createConfig());
  const balances = new Map<string, number>([['USDC', 1_000]]);

  (
    watchdog as unknown as {
      executeRepay: () => Promise<{ status: 'executed'; walletSpent: number }>;
    }
  ).executeRepay = async () => ({ status: 'executed', walletSpent: 250 });

  await watchdog.evaluate(createLoan(), WALLET, balances);

  assert.equal(balances.get('USDC'), 750);
  const cooldowns = (watchdog as unknown as { cooldowns: Map<string, number> }).cooldowns;
  assert.equal(cooldowns.has(`${WALLET}-loan-1`), true);
});

test('sets cooldown but preserves wallet balance when execution fails after partial on-chain progress', async () => {
  const watchdog = createWatchdog(createConfig());
  const balances = new Map<string, number>([['USDC', 1_000]]);

  (
    watchdog as unknown as {
      executeRepay: () => Promise<{ status: 'failed'; hadPartialExecution: boolean }>;
    }
  ).executeRepay = async () => ({ status: 'failed', hadPartialExecution: true });

  await watchdog.evaluate(createLoan(), WALLET, balances);

  assert.equal(balances.get('USDC'), 1_000);
  const cooldowns = (watchdog as unknown as { cooldowns: Map<string, number> }).cooldowns;
  assert.equal(cooldowns.has(`${WALLET}-loan-1`), true);
});

test('does not set cooldown when execution fails without partial on-chain progress', async () => {
  const watchdog = createWatchdog(createConfig());
  const balances = new Map<string, number>([['USDC', 1_000]]);

  (
    watchdog as unknown as {
      executeRepay: () => Promise<{ status: 'failed'; hadPartialExecution: boolean }>;
    }
  ).executeRepay = async () => ({ status: 'failed', hadPartialExecution: false });

  await watchdog.evaluate(createLoan(), WALLET, balances);

  assert.equal(balances.get('USDC'), 1_000);
  const cooldowns = (watchdog as unknown as { cooldowns: Map<string, number> }).cooldowns;
  assert.equal(cooldowns.size, 0);
});
