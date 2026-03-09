import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatWatchdogStatusMessage,
  shouldRunMonitor,
  validateWatchdogThresholds,
} from '../src/runtime.js';
import type { AlertConfig, WatchdogConfig } from '../src/storage.js';
import type { WatchdogLogEntry } from '../src/watchdog.js';

function createConfig(walletEnabled: boolean): AlertConfig {
  return {
    wallets: [
      {
        address: '0x1111111111111111111111111111111111111111',
        enabled: walletEnabled,
      },
    ],
    telegram: {
      chatId: '',
      enabled: false,
    },
    polling: {
      intervalMs: 5 * 60 * 1000,
      debounceChecks: 2,
      reminderIntervalMs: 30 * 60 * 1000,
      cooldownMs: 30 * 60 * 1000,
    },
    zones: [
      { name: 'safe', minHF: 2.2, maxHF: Infinity },
      { name: 'comfort', minHF: 1.9, maxHF: 2.2 },
      { name: 'watch', minHF: 1.6, maxHF: 1.9 },
      { name: 'alert', minHF: 1.3, maxHF: 1.6 },
      { name: 'action', minHF: 1.15, maxHF: 1.3 },
      { name: 'critical', minHF: 0, maxHF: 1.15 },
    ],
    watchdog: {
      enabled: false,
      dryRun: true,
      triggerHF: 1.65,
      targetHF: 1.9,
      minResultingHF: 1.85,
      cooldownMs: 30 * 60 * 1000,
      maxTopUpWbtc: 0.5,
      deadlineSeconds: 300,
      rescueContract: '0x2222222222222222222222222222222222222222',
      maxGasGwei: 50,
    },
  };
}

function createWatchdogConfig(): WatchdogConfig {
  return {
    enabled: true,
    dryRun: true,
    triggerHF: 1.65,
    targetHF: 1.9,
    minResultingHF: 1.85,
    cooldownMs: 30 * 60 * 1000,
    maxTopUpWbtc: 0.5,
    deadlineSeconds: 300,
    rescueContract: '0x2222222222222222222222222222222222222222',
    maxGasGwei: 50,
  };
}

test('shouldRunMonitor returns true when at least one wallet is enabled', () => {
  assert.equal(shouldRunMonitor(createConfig(true)), true);
  assert.equal(shouldRunMonitor(createConfig(false)), false);
});

test('validateWatchdogThresholds enforces targetHF above triggerHF', () => {
  const current = createWatchdogConfig();

  assert.equal(
    validateWatchdogThresholds(current, { targetHF: 1.2 }),
    'watchdog.targetHF must be greater than watchdog.triggerHF',
  );
  assert.equal(validateWatchdogThresholds(current, { triggerHF: 1.6 }), null);
  assert.equal(validateWatchdogThresholds(current, { triggerHF: 1.6, targetHF: 2.0 }), null);
  assert.equal(
    validateWatchdogThresholds(current, { minResultingHF: 1.6 }),
    'watchdog.minResultingHF must be greater than watchdog.triggerHF',
  );
  assert.equal(
    validateWatchdogThresholds(current, { minResultingHF: 2.1 }),
    'watchdog.minResultingHF must be less than or equal to watchdog.targetHF',
  );
  assert.equal(validateWatchdogThresholds(current, undefined), null);
});

test('formatWatchdogStatusMessage escapes html-sensitive log content', () => {
  const summary = {
    enabled: true,
    dryRun: true,
    hasPrivateKey: false,
    triggerHF: 1.65,
    targetHF: 1.9,
    minResultingHF: 1.85,
    rescueContract: '0x2222222222222222222222222222222222222222',
    recentActions: 1,
  };
  const log: WatchdogLogEntry[] = [
    {
      timestamp: Date.now(),
      loanId: 'loan-1',
      wallet: '0x1111111111111111111111111111111111111111',
      action: 'skipped',
      reason: 'Execution failed: bad <tag> & "quoted"',
      healthFactor: 1.2,
      topUpWbtc: 0,
      projectedHF: 1.2,
    },
  ];

  const message = formatWatchdogStatusMessage(summary, log);
  assert.match(message, /Execution failed: bad &lt;tag&gt; &amp; &quot;quoted&quot;/);
  assert.doesNotMatch(message, /Execution failed: bad <tag> & "quoted"/);
});
