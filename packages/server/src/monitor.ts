import {
  type Zone,
  type ZoneName,
  classifyZone,
  isWorsening,
  isImproving,
  fetchFromAaveSubgraph,
  fetchUsdPrices,
  buildLoanPositions,
  computeLoanMetrics,
  DEFAULT_R_DEPLOY,
  DEFAULT_ZONES,
} from '@aave-monitor/core';
import type { AlertConfig } from './storage.js';
import type { TelegramClient } from './telegram.js';

export type LoanAlertState = {
  loanId: string;
  wallet: string;
  healthFactor: number;
  currentZone: Zone;
  lastNotifiedZone: ZoneName | null;
  lastNotifiedAt: number;
  consecutiveChecks: number;
  stuckSince: number | null;
};

export type MonitorStatus = {
  running: boolean;
  states: LoanAlertState[];
  lastPollAt: number | null;
  lastError: string | null;
};

export class Monitor {
  private states = new Map<string, LoanAlertState>();
  private timerId: ReturnType<typeof setInterval> | null = null;
  private lastPollAt: number | null = null;
  private lastError: string | null = null;
  private running = false;

  constructor(
    private readonly telegram: TelegramClient,
    private readonly getConfig: () => AlertConfig,
    private readonly graphApiKey: string | undefined,
    private readonly coingeckoApiKey: string | undefined,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const config = this.getConfig();
    this.timerId = setInterval(() => {
      void this.poll();
    }, config.polling.intervalMs);
    void this.poll();
    console.log(`Monitor started (interval: ${config.polling.intervalMs}ms)`);
  }

  stop(): void {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.running = false;
    console.log('Monitor stopped');
  }

  restart(): void {
    this.stop();
    this.start();
  }

  getStatus(): MonitorStatus {
    return {
      running: this.running,
      states: Array.from(this.states.values()),
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
    };
  }

  async refreshState(): Promise<MonitorStatus> {
    await this.poll({ notify: false });
    return this.getStatus();
  }

  private async poll(options: { notify: boolean } = { notify: true }): Promise<void> {
    const config = this.getConfig();
    const chatId =
      options.notify && config.telegram.enabled && config.telegram.chatId
        ? config.telegram.chatId
        : null;

    const enabledWallets = config.wallets.filter((w) => w.enabled);
    if (enabledWallets.length === 0) {
      this.lastPollAt = Date.now();
      this.lastError = null;
      return;
    }

    try {
      for (const wallet of enabledWallets) {
        await this.checkWallet(wallet.address, wallet.label, config, chatId);
      }
      this.lastPollAt = Date.now();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Unknown polling error';
      console.error('Poll error:', this.lastError);
    }
  }

  private async checkWallet(
    address: string,
    label: string | undefined,
    config: AlertConfig,
    chatId: string | null,
  ): Promise<void> {
    const reserves = await fetchFromAaveSubgraph(address, this.graphApiKey);
    const symbols = Array.from(new Set(reserves.map((r) => r.reserve.symbol)));
    const prices = await fetchUsdPrices(symbols, this.coingeckoApiKey);

    const pricedSymbols = symbols.filter((s) => prices.has(s));
    const missingSymbols = symbols.filter((s) => !prices.has(s));
    console.log(
      `[Monitor] Prices for ${this.shortAddr(address)}: ${pricedSymbols.length}/${symbols.length} resolved.` +
        (missingSymbols.length > 0 ? ` Missing: ${missingSymbols.join(', ')}` : ''),
    );

    const loans = buildLoanPositions(reserves, prices);
    const now = Date.now();

    for (const loan of loans) {
      const metrics = computeLoanMetrics(loan, DEFAULT_R_DEPLOY);
      const zone = classifyZone(metrics.healthFactor, this.hydrateZones(config.zones));
      const stateKey = `${address}-${loan.id}`;

      const collateralInfo = loan.supplied
        .map((c) => `${c.symbol}=$${prices.get(c.symbol) ?? 'MISSING'}`)
        .join(', ');
      console.log(
        `[Monitor] ${this.shortAddr(address)} loan=${loan.id} ` +
          `HF=${metrics.healthFactor.toFixed(4)} ` +
          `borrowed=$${loan.totalBorrowedUsd.toFixed(2)} supplied=$${loan.totalSuppliedUsd.toFixed(2)} ` +
          `zone=${zone.name} collaterals=[${collateralInfo}]`,
      );

      const existing = this.states.get(stateKey);

      if (!existing) {
        this.states.set(stateKey, {
          loanId: loan.id,
          wallet: address,
          healthFactor: metrics.healthFactor,
          currentZone: zone,
          lastNotifiedZone: null,
          lastNotifiedAt: 0,
          consecutiveChecks: 1,
          stuckSince: zone.name !== 'safe' ? now : null,
        });
        continue;
      }

      const previousZone = existing.currentZone;
      existing.healthFactor = metrics.healthFactor;
      existing.currentZone = zone;

      if (zone.name === previousZone.name) {
        existing.consecutiveChecks++;

        if (zone.name !== 'safe' && existing.stuckSince) {
          const stuckDuration = now - existing.stuckSince;
          if (
            chatId &&
            stuckDuration >= config.polling.reminderIntervalMs &&
            now - existing.lastNotifiedAt >= config.polling.reminderIntervalMs
          ) {
            await this.sendNotification(
              chatId,
              this.formatReminder(address, label, loan, metrics, zone, stuckDuration),
            );
            existing.lastNotifiedAt = now;
          }
        }
        continue;
      }

      existing.consecutiveChecks = 1;
      existing.stuckSince = zone.name !== 'safe' ? now : null;

      if (isWorsening(previousZone.name, zone.name)) {
        const isCritical = zone.name === 'critical';
        const shouldNotify =
          isCritical || existing.consecutiveChecks >= config.polling.debounceChecks;

        if (chatId && (shouldNotify || isCritical)) {
          await this.sendNotification(
            chatId,
            this.formatZoneTransition(address, label, loan, metrics, zone, previousZone),
          );
          existing.lastNotifiedZone = zone.name;
          existing.lastNotifiedAt = now;
        }
      } else if (isImproving(previousZone.name, zone.name)) {
        const cooldownElapsed = now - existing.lastNotifiedAt >= config.polling.cooldownMs;
        if (chatId && cooldownElapsed) {
          if (zone.name === 'safe') {
            await this.sendNotification(chatId, this.formatAllClear(address, label, loan, metrics));
          } else {
            await this.sendNotification(
              chatId,
              this.formatRecovery(address, label, loan, metrics, zone, previousZone),
            );
          }
          existing.lastNotifiedZone = zone.name;
          existing.lastNotifiedAt = now;
        }
      }
    }
  }

  private hydrateZones(configuredZones: AlertConfig['zones'] | undefined): Zone[] {
    if (!configuredZones || configuredZones.length === 0) {
      return DEFAULT_ZONES;
    }

    const thresholdsByName = new Map(
      configuredZones.map((zone) => [zone.name, { minHF: zone.minHF, maxHF: zone.maxHF }]),
    );

    return DEFAULT_ZONES.map((zone) => {
      const override = thresholdsByName.get(zone.name);
      if (!override) return zone;
      return { ...zone, minHF: override.minHF, maxHF: override.maxHF };
    });
  }

  private async sendNotification(chatId: string, message: string): Promise<void> {
    const success = await this.telegram.sendMessage(chatId, message);
    if (!success) {
      console.error('Failed to send Telegram notification');
    }
  }

  private formatZoneTransition(
    address: string,
    label: string | undefined,
    loan: {
      marketName: string;
      borrowed: { symbol: string };
      totalBorrowedUsd: number;
      totalSuppliedUsd: number;
    },
    metrics: {
      healthFactor: number;
      liqPrice: number;
      priceDropToLiq: number;
      primaryCollateralSymbol: string;
    },
    zone: Zone,
    previousZone: Zone,
  ): string {
    const walletLabel = label ? `${label} (${this.shortAddr(address)})` : this.shortAddr(address);
    const hf = Number.isFinite(metrics.healthFactor) ? metrics.healthFactor.toFixed(2) : '∞';
    const liqPrice = Number.isFinite(metrics.liqPrice) ? `$${metrics.liqPrice.toFixed(2)}` : 'N/A';
    const distToLiq = (metrics.priceDropToLiq * 100).toFixed(1);

    return [
      `${zone.emoji} <b>${zone.label}</b> — Loan Health Changed`,
      '',
      `Wallet: <code>${walletLabel}</code>`,
      `Market: ${loan.marketName}`,
      `Borrowed: $${loan.totalBorrowedUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${loan.borrowed.symbol} | Collateral: $${loan.totalSuppliedUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      '',
      `Health Factor: <b>${hf}</b>`,
      `Zone: ${zone.emoji} ${zone.label} (was ${previousZone.emoji} ${previousZone.label})`,
      `Action: ${zone.action}`,
      '',
      `Liquidation price (${metrics.primaryCollateralSymbol}): ${liqPrice}`,
      `Distance to liquidation: ${distToLiq}%`,
    ].join('\n');
  }

  private formatRecovery(
    address: string,
    label: string | undefined,
    loan: { marketName: string; borrowed: { symbol: string } },
    metrics: { healthFactor: number },
    zone: Zone,
    previousZone: Zone,
  ): string {
    const walletLabel = label ? `${label} (${this.shortAddr(address)})` : this.shortAddr(address);
    const hf = Number.isFinite(metrics.healthFactor) ? metrics.healthFactor.toFixed(2) : '∞';

    return [
      `${zone.emoji} <b>IMPROVING</b> — Zone Recovery`,
      '',
      `Wallet: <code>${walletLabel}</code>`,
      `Market: ${loan.marketName} · ${loan.borrowed.symbol}`,
      `Health Factor: <b>${hf}</b>`,
      `Zone: ${zone.emoji} ${zone.label} (was ${previousZone.emoji} ${previousZone.label})`,
    ].join('\n');
  }

  private formatAllClear(
    address: string,
    label: string | undefined,
    loan: { marketName: string; borrowed: { symbol: string } },
    metrics: { healthFactor: number },
  ): string {
    const walletLabel = label ? `${label} (${this.shortAddr(address)})` : this.shortAddr(address);
    const hf = Number.isFinite(metrics.healthFactor) ? metrics.healthFactor.toFixed(2) : '∞';

    return [
      `\u{1F7E2} <b>ALL CLEAR</b> — Back to Safe`,
      '',
      `Wallet: <code>${walletLabel}</code>`,
      `Market: ${loan.marketName} · ${loan.borrowed.symbol}`,
      `Health Factor: <b>${hf}</b>`,
      '',
      `All positions are healthy. Monitoring continues.`,
    ].join('\n');
  }

  private formatReminder(
    address: string,
    label: string | undefined,
    loan: { marketName: string; borrowed: { symbol: string } },
    metrics: { healthFactor: number },
    zone: Zone,
    stuckDurationMs: number,
  ): string {
    const walletLabel = label ? `${label} (${this.shortAddr(address)})` : this.shortAddr(address);
    const hf = Number.isFinite(metrics.healthFactor) ? metrics.healthFactor.toFixed(2) : '∞';
    const minutes = Math.round(stuckDurationMs / 60_000);

    return [
      `${zone.emoji} <b>REMINDER</b> — Still in ${zone.label} zone`,
      '',
      `Wallet: <code>${walletLabel}</code>`,
      `Market: ${loan.marketName} · ${loan.borrowed.symbol}`,
      `Health Factor: <b>${hf}</b>`,
      `Duration: ${minutes} minutes`,
      `Action: ${zone.action}`,
    ].join('\n');
  }

  private shortAddr(address: string): string {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}
