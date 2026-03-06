import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConfigStorage, type AlertConfig } from '../src/storage.js';

function createBaseConfig(): Omit<AlertConfig, 'watchdog'> {
  return {
    wallets: [],
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
      { name: 'safe', minHF: 2.2, maxHF: 999 },
      { name: 'comfort', minHF: 1.9, maxHF: 2.2 },
      { name: 'watch', minHF: 1.6, maxHF: 1.9 },
      { name: 'alert', minHF: 1.3, maxHF: 1.6 },
      { name: 'action', minHF: 1.15, maxHF: 1.3 },
      { name: 'critical', minHF: 0, maxHF: 1.15 },
    ],
  };
}

test('load() merges missing watchdog fields from defaults when persisted config is partial', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aash-storage-test-'));
  const configPath = join(dir, 'config.json');
  const saved = {
    ...createBaseConfig(),
    watchdog: {
      enabled: true,
    },
  };

  try {
    writeFileSync(configPath, JSON.stringify(saved, null, 2), 'utf-8');

    const storage = new ConfigStorage(configPath);
    const watchdog = storage.get().watchdog;

    assert.equal(watchdog.enabled, true);
    assert.equal(watchdog.dryRun, true);
    assert.equal(watchdog.cooldownMs, 30 * 60 * 1000);
    assert.equal(watchdog.maxRepayUsd, 10_000);
    assert.equal(watchdog.maxGasGwei, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('update() merges partial watchdog payload with existing watchdog config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aash-storage-test-'));
  const configPath = join(dir, 'config.json');

  try {
    const storage = new ConfigStorage(configPath);
    storage.update({
      watchdog: {
        enabled: true,
        dryRun: false,
        triggerHF: 1.2,
        targetHF: 1.6,
        cooldownMs: 1000,
        maxRepayUsd: 5000,
        maxGasGwei: 10,
      },
    });

    storage.update({ watchdog: { targetHF: 2.0 } } as unknown as Partial<AlertConfig>);

    const watchdog = storage.get().watchdog;
    assert.equal(watchdog.enabled, true);
    assert.equal(watchdog.dryRun, false);
    assert.equal(watchdog.triggerHF, 1.2);
    assert.equal(watchdog.targetHF, 2.0);
    assert.equal(watchdog.cooldownMs, 1000);
    assert.equal(watchdog.maxRepayUsd, 5000);
    assert.equal(watchdog.maxGasGwei, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
