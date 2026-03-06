import assert from 'node:assert/strict';
import test from 'node:test';
import { computeAdjustedHF, type LoanPosition } from '@aave-monitor/core';
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

test('does not mutate wallet balance or set cooldown when live execution is skipped', async () => {
  const { watchdog } = createWatchdog(createConfig());
  const balances = new Map<string, number>([['USDC', 1_000]]);

  (watchdog as unknown as { executeRepay: () => Promise<{ status: 'skipped' }> }).executeRepay =
    async () => ({ status: 'skipped' });

  await watchdog.evaluate(createLoan(), WALLET, balances);

  assert.equal(balances.get('USDC'), 1_000);
  const cooldowns = (watchdog as unknown as { cooldowns: Map<string, number> }).cooldowns;
  assert.equal(cooldowns.size, 0);
});

test('mutates wallet balance and sets cooldown when live execution succeeds', async () => {
  const { watchdog } = createWatchdog(createConfig());
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
  const { watchdog } = createWatchdog(createConfig());
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
  const { watchdog } = createWatchdog(createConfig());
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

test('dry-run sends notification and applies cooldown without executing on-chain calls', async () => {
  const { watchdog, messages } = createWatchdog(createConfig({ dryRun: true, maxRepayUsd: 100 }));
  const balances = new Map<string, number>([['USDC', 1_000]]);
  let executeCalled = 0;
  (
    watchdog as unknown as {
      executeRepay: () => Promise<{ status: 'executed'; walletSpent: number }>;
    }
  ).executeRepay = async () => {
    executeCalled++;
    return { status: 'executed', walletSpent: 0 };
  };

  await watchdog.evaluate(createLoan(), WALLET, balances);

  assert.equal(executeCalled, 0);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /Watchdog DRY RUN/);
  assert.match(messages[0]!, /Would repay: <b>100\.00 USDC<\/b>/);
  const cooldowns = (watchdog as unknown as { cooldowns: Map<string, number> }).cooldowns;
  assert.equal(cooldowns.has(`${WALLET}-loan-1`), true);
});

test('cooldown prevents re-execution during consecutive evaluations', async () => {
  const { watchdog } = createWatchdog(createConfig());
  const balances = new Map<string, number>([['USDC', 1_000]]);
  let executeCalled = 0;
  (
    watchdog as unknown as {
      executeRepay: () => Promise<{ status: 'executed'; walletSpent: number }>;
    }
  ).executeRepay = async () => {
    executeCalled++;
    return { status: 'executed', walletSpent: 10 };
  };

  await watchdog.evaluate(createLoan(), WALLET, balances);
  await watchdog.evaluate(createLoan(), WALLET, balances);

  assert.equal(executeCalled, 1);
});

test('repayment amount is capped by maxRepayUsd and can include withdraw funding', async () => {
  const { watchdog } = createWatchdog(createConfig({ maxRepayUsd: 100 }));
  const balances = new Map<string, number>([['USDC', 50]]);
  const loan = createLoan();
  loan.supplied.push({
    symbol: 'USDC',
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amount: 200,
    usdPrice: 1,
    usdValue: 200,
    collateralEnabled: true,
    maxLTV: 0,
    liqThreshold: 0,
    supplyRate: 0,
    borrowRate: 0,
  });

  let capturedRepay = 0;
  let capturedWithdraw = 0;
  (
    watchdog as unknown as {
      executeRepay: (
        loan: LoanPosition,
        walletAddress: string,
        adjusted: unknown,
        repayAmount: number,
        withdrawAmount: number,
      ) => Promise<{ status: 'executed'; walletSpent: number }>;
    }
  ).executeRepay = async (_loan, _walletAddress, _adjusted, repayAmount, withdrawAmount) => {
    capturedRepay = repayAmount;
    capturedWithdraw = withdrawAmount;
    return { status: 'executed', walletSpent: repayAmount - withdrawAmount };
  };

  await watchdog.evaluate(loan, WALLET, balances);

  assert.equal(capturedRepay, 100);
  assert.equal(capturedWithdraw, 50);
});

test('non-stablecoin debt is skipped', async () => {
  const { watchdog } = createWatchdog(createConfig());
  const balances = new Map<string, number>([['USDC', 1_000]]);
  const loan = createLoan();
  loan.borrowed.symbol = 'WETH';

  let executeCalled = 0;
  (
    watchdog as unknown as {
      executeRepay: () => Promise<{ status: 'executed'; walletSpent: number }>;
    }
  ).executeRepay = async () => {
    executeCalled++;
    return { status: 'executed', walletSpent: 0 };
  };

  await watchdog.evaluate(loan, WALLET, balances);
  assert.equal(executeCalled, 0);
});

test('live mode without private key is logged and skipped', async () => {
  const { watchdog } = createWatchdog(createConfig(), { privateKey: null });
  const balances = new Map<string, number>([['USDC', 1_000]]);

  await watchdog.evaluate(createLoan(), WALLET, balances);

  const log = watchdog.getLog();
  assert.equal(log.length, 1);
  assert.match(log[0]!.reason, /No private key configured/);
});

test('executeRepay skips when gas price exceeds configured max and notifies', async () => {
  const { watchdog, messages } = createWatchdog(createConfig({ maxGasGwei: 1 }));
  (
    watchdog as unknown as {
      getGasPrice: () => Promise<number>;
      getEthBalance: () => Promise<number>;
      sendTransaction: () => Promise<string>;
    }
  ).getGasPrice = async () => 2e9;
  (watchdog as unknown as { getEthBalance: () => Promise<number> }).getEthBalance = async () => 1;
  (watchdog as unknown as { sendTransaction: () => Promise<string> }).sendTransaction =
    async () => {
      throw new Error('should not send tx when gas is high');
    };

  const result = await (
    watchdog as unknown as {
      executeRepay: (
        loan: LoanPosition,
        walletAddress: string,
        adjusted: ReturnType<typeof computeAdjustedHF>,
        repayAmount: number,
        withdrawAmount: number,
        config: WatchdogConfig,
      ) => Promise<{ status: string }>;
    }
  ).executeRepay(
    createLoan(),
    WALLET,
    computeAdjustedHF(createLoan()),
    100,
    0,
    createConfig({ maxGasGwei: 1 }),
  );

  assert.equal(result.status, 'skipped');
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /Gas too high/);
});

test('executeRepay skips when ETH balance is too low and notifies', async () => {
  const config = createConfig();
  const { watchdog, messages } = createWatchdog(config);
  (
    watchdog as unknown as {
      getGasPrice: () => Promise<number>;
      getEthBalance: () => Promise<number>;
      sendTransaction: () => Promise<string>;
    }
  ).getGasPrice = async () => 1e9;
  (watchdog as unknown as { getEthBalance: () => Promise<number> }).getEthBalance = async () =>
    0.001;
  (watchdog as unknown as { sendTransaction: () => Promise<string> }).sendTransaction =
    async () => {
      throw new Error('should not send tx when ETH is insufficient');
    };

  const result = await (
    watchdog as unknown as {
      executeRepay: (
        loan: LoanPosition,
        walletAddress: string,
        adjusted: ReturnType<typeof computeAdjustedHF>,
        repayAmount: number,
        withdrawAmount: number,
        config: WatchdogConfig,
      ) => Promise<{ status: string }>;
    }
  ).executeRepay(createLoan(), WALLET, computeAdjustedHF(createLoan()), 100, 0, config);

  assert.equal(result.status, 'skipped');
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /Insufficient ETH for gas/);
});
