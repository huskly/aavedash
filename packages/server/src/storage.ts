import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ZoneName } from '@aave-monitor/core';

export type WalletConfig = {
  address: string;
  label?: string;
  enabled: boolean;
};

export type ZoneConfig = {
  name: ZoneName;
  minHF: number;
  maxHF: number;
};

export type AlertConfig = {
  wallets: WalletConfig[];
  telegram: {
    chatId: string;
    enabled: boolean;
  };
  polling: {
    intervalMs: number;
    debounceChecks: number;
    reminderIntervalMs: number;
    cooldownMs: number;
  };
  zones: ZoneConfig[];
};

const DEFAULT_CONFIG: AlertConfig = {
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
    { name: 'safe', minHF: 2.0, maxHF: Infinity },
    { name: 'watch', minHF: 1.5, maxHF: 2.0 },
    { name: 'alert', minHF: 1.25, maxHF: 1.5 },
    { name: 'action', minHF: 1.1, maxHF: 1.25 },
    { name: 'critical', minHF: 0, maxHF: 1.1 },
  ],
};

export class ConfigStorage {
  private config: AlertConfig;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.config = this.load();
  }

  private load(): AlertConfig {
    try {
      if (!existsSync(this.filePath)) {
        return structuredClone(DEFAULT_CONFIG);
      }
      const raw = readFileSync(this.filePath, 'utf-8');
      const config = JSON.parse(raw) as AlertConfig;
      // JSON.stringify turns Infinity into null; restore it on load
      if (config.zones) {
        for (const zone of config.zones) {
          if (zone.maxHF === null || zone.maxHF === undefined) {
            zone.maxHF = Infinity;
          }
        }
      }
      return config;
    } catch {
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  get(): AlertConfig {
    return this.config;
  }

  update(partial: Partial<AlertConfig>): AlertConfig {
    if (partial.wallets !== undefined) this.config.wallets = partial.wallets;
    if (partial.telegram !== undefined) this.config.telegram = partial.telegram;
    if (partial.polling !== undefined) this.config.polling = partial.polling;
    if (partial.zones !== undefined) this.config.zones = partial.zones;
    this.save();
    return this.config;
  }
}
