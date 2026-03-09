import {
  type AssetLiquidation,
  type Zone,
  type ZoneName,
  classifyZone,
  isWorsening,
  isImproving,
  fetchFromAaveSubgraph,
  fetchUsdPrices,
  fetchStablecoinBalances,
  buildLoanPositions,
  computeLoanMetrics,
  STABLECOIN_SYMBOLS,
  DEFAULT_R_DEPLOY,
  DEFAULT_ZONES,
} from '@aave-monitor/core';
import { intervalToDuration } from 'date-fns';
import type { AlertConfig } from './storage.js';
import type { TelegramClient } from './telegram.js';
import { Watchdog, type WatchdogLogEntry } from './watchdog.js';

export type LoanAlertState = {
  loanId: string;
  wallet: string;
  healthFactor: number;
  adjustedHF: number;
  debtUsd: number;
  collateralUsd: number;
  suppliedStablecoinUsd: number;
  maxBorrowByLtvUsd: number;
  equityUsd: number;
  netEarnUsd: number;
  currentZone: Zone;
  lastNotifiedZone: ZoneName | null;
  lastNotifiedAt: number;
  consecutiveChecks: number;
  stuckSince: number | null;
};

export type MonitorStatus = {
  running: boolean;
  states: LoanAlertState[];
  totalWalletStablecoinUsd: number;
  lastPollAt: number | null;
  lastError: string | null;
  watchdogLog: WatchdogLogEntry[];
};

export class Monitor {
  private states = new Map<string, LoanAlertState>();
  private timerId: ReturnType<typeof setInterval> | null = null;
  private walletStablecoinUsd = new Map<string, number>();
  private lastPollAt: number | null = null;
  private lastError: string | null = null;
  private running = false;
  readonly watchdog: Watchdog;

  constructor(
    private readonly telegram: TelegramClient,
    private readonly getConfig: () => AlertConfig,
    private readonly graphApiKey: string | undefined,
    private readonly coingeckoApiKey: string | undefined,
    private readonly rpcUrl: string,
    privateKey: string | undefined,
  ) {
    this.watchdog = new Watchdog(
      telegram,
      () => {
        const config = this.getConfig();
        return config.telegram.enabled && config.telegram.chatId ? config.telegram.chatId : null;
      },
      () => this.getConfig().watchdog,
      rpcUrl,
      privateKey,
    );
  }

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
      totalWalletStablecoinUsd: Array.from(this.walletStablecoinUsd.values()).reduce(
        (sum, value) => sum + value,
        0,
      ),
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      watchdogLog: this.watchdog.getLog(),
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
    const enabledAddresses = new Set(enabledWallets.map((wallet) => wallet.address.toLowerCase()));
    for (const [stateKey, state] of Array.from(this.states.entries())) {
      if (!enabledAddresses.has(state.wallet.toLowerCase())) {
        this.states.delete(stateKey);
      }
    }
    for (const existingAddress of Array.from(this.walletStablecoinUsd.keys())) {
      if (!enabledAddresses.has(existingAddress)) {
        this.walletStablecoinUsd.delete(existingAddress);
      }
    }

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
    const walletStablecoinBalances = await fetchStablecoinBalances(address, this.rpcUrl).catch(
      () => {
        console.warn(
          `[Monitor] Stablecoin wallet balances unavailable for ${this.shortAddr(address)}`,
        );
        return new Map<string, number>();
      },
    );
    const walletStablecoinUsd = Array.from(walletStablecoinBalances.values()).reduce(
      (sum, value) => sum + value,
      0,
    );
    this.walletStablecoinUsd.set(address.toLowerCase(), walletStablecoinUsd);

    const now = Date.now();
    const activeStateKeys = new Set<string>();

    for (const loan of loans) {
      const metrics = computeLoanMetrics(loan, DEFAULT_R_DEPLOY);
      const suppliedStablecoinUsd = loan.supplied.reduce(
        (sum, asset) => (STABLECOIN_SYMBOLS.has(asset.symbol) ? sum + asset.usdValue : sum),
        0,
      );
      const zone = classifyZone(metrics.healthFactor, this.hydrateZones(config.zones));
      const stateKey = `${address}-${loan.id}`;
      activeStateKeys.add(stateKey);

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
          adjustedHF: metrics.adjustedHF,
          debtUsd: metrics.debt,
          collateralUsd: metrics.collateralUSD,
          suppliedStablecoinUsd,
          maxBorrowByLtvUsd: metrics.maxBorrowByLTV,
          equityUsd: metrics.equity,
          netEarnUsd: metrics.netEarnUSD,
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
      existing.adjustedHF = metrics.adjustedHF;
      existing.debtUsd = metrics.debt;
      existing.collateralUsd = metrics.collateralUSD;
      existing.suppliedStablecoinUsd = suppliedStablecoinUsd;
      existing.maxBorrowByLtvUsd = metrics.maxBorrowByLTV;
      existing.equityUsd = metrics.equity;
      existing.netEarnUsd = metrics.netEarnUSD;
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

    // Watchdog evaluation pass — runs after alerts so notifications always go out first
    for (const loan of loans) {
      await this.watchdog.evaluate(loan, address);
    }

    const walletPrefix = `${address}-`;
    for (const stateKey of Array.from(this.states.keys())) {
      if (stateKey.startsWith(walletPrefix) && !activeStateKeys.has(stateKey)) {
        this.states.delete(stateKey);
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
      adjustedHF: number;
      assetLiquidations: AssetLiquidation[];
    },
    zone: Zone,
    previousZone: Zone,
  ): string {
    const walletLabel = label ? `${label} (${this.shortAddr(address)})` : this.shortAddr(address);
    const hf = Number.isFinite(metrics.healthFactor) ? metrics.healthFactor.toFixed(2) : '∞';
    const adjHf = Number.isFinite(metrics.adjustedHF) ? metrics.adjustedHF.toFixed(2) : '∞';

    const lines = [
      `${zone.emoji} <b>${zone.label}</b> — Loan Health Changed`,
      '',
      `Wallet: <code>${walletLabel}</code>`,
      `Market: ${loan.marketName}`,
      `Borrowed: $${loan.totalBorrowedUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${loan.borrowed.symbol} | Collateral: $${loan.totalSuppliedUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      '',
      `Health Factor: <b>${hf}</b> · Adjusted: <b>${adjHf}</b>`,
      `Zone: ${zone.emoji} ${zone.label} (was ${previousZone.emoji} ${previousZone.label})`,
      `Action: ${zone.action}`,
      '',
    ];

    for (const al of metrics.assetLiquidations) {
      const liqPrice = Number.isFinite(al.liqPrice) ? `$${al.liqPrice.toFixed(2)}` : 'N/A';
      const distToLiq = (al.priceDropToLiq * 100).toFixed(1);
      lines.push(`Liq price (${al.symbol}): ${liqPrice} (−${distToLiq}%)`);
    }

    return lines.join('\n');
  }

  private formatRecovery(
    address: string,
    label: string | undefined,
    loan: { marketName: string; borrowed: { symbol: string } },
    metrics: { healthFactor: number; adjustedHF: number },
    zone: Zone,
    previousZone: Zone,
  ): string {
    const walletLabel = label ? `${label} (${this.shortAddr(address)})` : this.shortAddr(address);
    const hf = Number.isFinite(metrics.healthFactor) ? metrics.healthFactor.toFixed(2) : '∞';
    const adjHf = Number.isFinite(metrics.adjustedHF) ? metrics.adjustedHF.toFixed(2) : '∞';

    return [
      `${zone.emoji} <b>IMPROVING</b> — Zone Recovery`,
      '',
      `Wallet: <code>${walletLabel}</code>`,
      `Market: ${loan.marketName} · ${loan.borrowed.symbol}`,
      `Health Factor: <b>${hf}</b> · Adjusted: <b>${adjHf}</b>`,
      `Zone: ${zone.emoji} ${zone.label} (was ${previousZone.emoji} ${previousZone.label})`,
    ].join('\n');
  }

  private formatAllClear(
    address: string,
    label: string | undefined,
    loan: { marketName: string; borrowed: { symbol: string } },
    metrics: { healthFactor: number; adjustedHF: number },
  ): string {
    const walletLabel = label ? `${label} (${this.shortAddr(address)})` : this.shortAddr(address);
    const hf = Number.isFinite(metrics.healthFactor) ? metrics.healthFactor.toFixed(2) : '∞';
    const adjHf = Number.isFinite(metrics.adjustedHF) ? metrics.adjustedHF.toFixed(2) : '∞';

    return [
      `\u{1F7E2} <b>ALL CLEAR</b> — Back to Safe`,
      '',
      `Wallet: <code>${walletLabel}</code>`,
      `Market: ${loan.marketName} · ${loan.borrowed.symbol}`,
      `Health Factor: <b>${hf}</b> · Adjusted: <b>${adjHf}</b>`,
      '',
      `All positions are healthy. Monitoring continues.`,
    ].join('\n');
  }

  private formatReminder(
    address: string,
    label: string | undefined,
    loan: { marketName: string; borrowed: { symbol: string } },
    metrics: { healthFactor: number; adjustedHF: number },
    zone: Zone,
    stuckDurationMs: number,
  ): string {
    const walletLabel = label ? `${label} (${this.shortAddr(address)})` : this.shortAddr(address);
    const hf = Number.isFinite(metrics.healthFactor) ? metrics.healthFactor.toFixed(2) : '∞';
    const adjHf = Number.isFinite(metrics.adjustedHF) ? metrics.adjustedHF.toFixed(2) : '∞';
    const timeAgo = this.formatTimeAgo(stuckDurationMs);

    return [
      `${zone.emoji} <b>REMINDER</b> — Still in ${zone.label} zone`,
      '',
      `Wallet: <code>${walletLabel}</code>`,
      `Market: ${loan.marketName} · ${loan.borrowed.symbol}`,
      `Health Factor: <b>${hf}</b> · Adjusted: <b>${adjHf}</b>`,
      `Duration: ${timeAgo} ago`,
      `Action: ${zone.action}`,
    ].join('\n');
  }

  private formatTimeAgo(durationMs: number): string {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return '<1m';

    const {
      days = 0,
      hours = 0,
      minutes = 0,
    } = intervalToDuration({
      start: 0,
      end: durationMs,
    });

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    if (parts.length === 0) {
      return '<1m';
    }

    return parts.slice(0, 2).join(' ');
  }

  private shortAddr(address: string): string {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}
