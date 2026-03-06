import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { formatDistanceToNowStrict } from 'date-fns';
import {
  classifyZone,
  DEFAULT_ZONES,
  type Zone,
  fetchStablecoinBalances,
} from '@aave-monitor/core';
import { ConfigStorage, type AlertConfig, type WatchdogConfig } from './storage.js';
import { TelegramClient, type TelegramBotCommand } from './telegram.js';
import { Monitor } from './monitor.js';
import {
  formatWatchdogStatusMessage,
  shouldRunMonitor,
  validateWatchdogThresholds,
} from './runtime.js';

const partialAlertConfigSchema = z
  .object({
    wallets: z.array(
      z.object({
        address: z.string(),
        label: z.string().optional(),
        enabled: z.boolean(),
      }),
    ),
    telegram: z.object({
      chatId: z.string(),
      enabled: z.boolean(),
    }),
    polling: z.object({
      intervalMs: z.number().positive(),
      debounceChecks: z.number().positive(),
      reminderIntervalMs: z.number().positive(),
      cooldownMs: z.number().positive(),
    }),
    zones: z.array(
      z.object({
        name: z.enum(['safe', 'comfort', 'watch', 'alert', 'action', 'critical']),
        minHF: z.number(),
        maxHF: z.union([z.number(), z.null()]).transform((value) => value ?? Infinity),
      }),
    ),
    watchdog: z
      .object({
        enabled: z.boolean(),
        dryRun: z.boolean(),
        triggerHF: z.number().positive(),
        targetHF: z.number().positive(),
        cooldownMs: z.number().positive(),
        maxRepayUsd: z.number().positive(),
        maxGasGwei: z.number().positive(),
      })
      .partial(),
  })
  .partial();

type ConfigUpdate = Partial<Omit<AlertConfig, 'watchdog'>> & {
  watchdog?: Partial<WatchdogConfig>;
};

function parseConfigBody(body: unknown): { data: ConfigUpdate } | { error: string } {
  const result = partialAlertConfigSchema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    if (!issue) {
      return { error: 'Invalid request body' };
    }
    const path = issue.path.join('.');
    const message = path ? `${path}: ${issue.message}` : issue.message;
    return { error: message };
  }
  return { data: result.data };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV_PATH = join(__dirname, '..', '..', '..', '.env');

if (existsSync(ROOT_ENV_PATH)) {
  process.loadEnvFile(ROOT_ENV_PATH);
}

const PORT = Number(process.env.PORT ?? 3001);
const RPC_URL = process.env.VITE_RPC_URL ?? process.env.RPC_URL ?? 'https://rpc.mevblocker.io';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const GRAPH_API_KEY = process.env.VITE_THE_GRAPH_API_KEY ?? process.env.THE_GRAPH_API_KEY;
const COINGECKO_API_KEY = process.env.VITE_COINGECKO_API_KEY ?? process.env.COINGECKO_API_KEY;
const WATCHDOG_PRIVATE_KEY = process.env.WATCHDOG_PRIVATE_KEY;

const configPath = join(__dirname, '..', 'data', 'config.json');
const storage = new ConfigStorage(configPath);
const telegram = new TelegramClient(TELEGRAM_BOT_TOKEN);
const monitor = new Monitor(
  telegram,
  () => storage.get(),
  GRAPH_API_KEY,
  COINGECKO_API_KEY,
  RPC_URL,
  WATCHDOG_PRIVATE_KEY,
);

const TELEGRAM_BOT_COMMANDS: TelegramBotCommand[] = [
  { command: 'status', description: 'Show portfolio status and health factors' },
  { command: 'refresh', description: 'Refresh data and show updated status' },
  { command: 'watchdog', description: 'Show watchdog status and recent actions' },
  { command: 'help', description: 'List available commands' },
];

function syncRuntimeServices(options: { restartMonitor?: boolean } = {}): void {
  const { restartMonitor = false } = options;
  const config = storage.get();

  if (TELEGRAM_BOT_TOKEN) {
    void telegram.syncCommands(TELEGRAM_BOT_COMMANDS);
    telegram.startCommandPolling();
  } else {
    telegram.stopCommandPolling();
  }

  if (shouldRunMonitor(config)) {
    if (restartMonitor) {
      monitor.restart();
    } else {
      monitor.start();
    }
  } else {
    monitor.stop();
    console.log('Monitor not started: no enabled wallets');
  }
}

const app = express();
app.use(express.json());

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get('/api/config', (_req, res) => {
  const config = storage.get();
  res.json({
    wallets: config.wallets,
    telegram: { chatId: config.telegram.chatId, enabled: config.telegram.enabled },
    polling: config.polling,
    zones: config.zones,
    watchdog: config.watchdog,
  });
});

app.put('/api/config', (req, res) => {
  const parsed = parseConfigBody(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const watchdogError = validateWatchdogThresholds(storage.get().watchdog, parsed.data.watchdog);
  if (watchdogError) {
    res.status(400).json({ error: watchdogError });
    return;
  }
  const updated = storage.update(parsed.data);
  syncRuntimeServices({ restartMonitor: true });
  res.json({
    wallets: updated.wallets,
    telegram: { chatId: updated.telegram.chatId, enabled: updated.telegram.enabled },
    polling: updated.polling,
    zones: updated.zones,
    watchdog: updated.watchdog,
  });
});

app.post('/api/telegram/test', async (_req, res) => {
  const config = storage.get();
  if (!config.telegram.chatId) {
    res.status(400).json({ error: 'No chat ID configured' });
    return;
  }
  if (!TELEGRAM_BOT_TOKEN) {
    res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not set on server' });
    return;
  }

  const success = await telegram.sendMessage(
    config.telegram.chatId,
    '\u{2705} <b>Test notification</b>\n\nAave Loan Monitor is connected and working.',
  );

  if (success) {
    res.json({ ok: true });
  } else {
    res
      .status(502)
      .json({ error: 'Failed to send Telegram message. Check bot token and chat ID.' });
  }
});

app.get('/api/status', (_req, res) => {
  res.json(monitor.getStatus());
});

app.post('/api/status/refresh', async (_req, res) => {
  try {
    const status = await monitor.refreshState();
    res.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to refresh monitor state';
    res.status(500).json({ error: message });
  }
});

app.get('/api/balances/:wallet', async (req, res) => {
  const { wallet } = req.params;
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    res.status(400).json({ error: 'Invalid wallet address' });
    return;
  }

  try {
    const balances = await fetchStablecoinBalances(wallet, RPC_URL);
    res.json(Object.fromEntries(balances));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch balances';
    res.status(502).json({ error: message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/watchdog/status', (_req, res) => {
  const summary = monitor.watchdog.getStatusSummary();
  const log = monitor.watchdog.getLog();
  res.json({
    ...summary,
    log,
  });
});

// --- Telegram bot commands ---

function hydrateZones(configuredZones: AlertConfig['zones']): Zone[] {
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

function formatStatusMessage(
  status: ReturnType<typeof monitor.getStatus>,
  configuredZones: AlertConfig['zones'],
): string {
  const MIN_POSITION_USD = 0.01;
  const fmtUsd = (value: number): string =>
    `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const fmtPct = (value: number): string => `${(value * 100).toFixed(2)}%`;
  const fmtDateWithRelative = (value: number): string =>
    `${new Date(value).toLocaleString()} (${formatDistanceToNowStrict(value, { addSuffix: true })})`;
  const visibleStates = status.states.filter(
    (state) => state.debtUsd >= MIN_POSITION_USD || state.collateralUsd >= MIN_POSITION_USD,
  );

  if (!status.running) {
    return 'Monitor is not running.';
  }

  if (visibleStates.length === 0) {
    const lastPoll = status.lastPollAt
      ? `\nLast poll: ${new Date(status.lastPollAt).toLocaleString()}`
      : '';
    return `No active loan positions found.${lastPoll}`;
  }

  const lines: string[] = ['<b>Loan Status</b>', ''];
  const totals = visibleStates.reduce(
    (acc, state) => {
      acc.debt += state.debtUsd;
      acc.collateral += state.collateralUsd;
      acc.suppliedStablecoin += state.suppliedStablecoinUsd;
      acc.maxBorrowByLtv += state.maxBorrowByLtvUsd;
      acc.equity += state.equityUsd;
      acc.netEarn += state.netEarnUsd;
      return acc;
    },
    { debt: 0, collateral: 0, suppliedStablecoin: 0, maxBorrowByLtv: 0, equity: 0, netEarn: 0 },
  );
  const portfolioNetApy = totals.equity > 0 ? totals.netEarn / totals.equity : 0;
  const totalStablecoinUsd = totals.suppliedStablecoin + status.totalWalletStablecoinUsd;
  const cashMargin = totals.debt > 0 ? totalStablecoinUsd / totals.debt : 0;
  const borrowPowerUsed = totals.maxBorrowByLtv > 0 ? totals.debt / totals.maxBorrowByLtv : 0;
  const finiteHealthFactors = visibleStates
    .map((state) => state.healthFactor)
    .filter((healthFactor) => Number.isFinite(healthFactor));
  const averageHealthFactor =
    finiteHealthFactors.length > 0
      ? finiteHealthFactors.reduce((sum, healthFactor) => sum + healthFactor, 0) /
        finiteHealthFactors.length
      : Infinity;
  const avgHealthFactorLabel = Number.isFinite(averageHealthFactor)
    ? averageHealthFactor.toFixed(2)
    : '∞';
  const averageZone = classifyZone(averageHealthFactor, hydrateZones(configuredZones));

  lines.push(
    `<b>Portfolio</b>`,
    `${averageZone.emoji} Avg HF <b>${avgHealthFactorLabel}</b>`,
    `Net APY: <b>${fmtPct(portfolioNetApy)}</b>`,
    `Total collateral: <b>${fmtUsd(totals.collateral)}</b>`,
    `Total debt: <b>${fmtUsd(totals.debt)}</b>`,
    `Borrow power used: <b>${fmtPct(borrowPowerUsed)}</b>`,
    `Cash on hand: <b>${fmtUsd(totalStablecoinUsd)}</b> (${fmtPct(cashMargin)})`,
    '',
  );

  for (const state of visibleStates) {
    const addr = `${state.wallet.slice(0, 6)}...${state.wallet.slice(-4)}`;
    const hf = Number.isFinite(state.healthFactor) ? state.healthFactor.toFixed(2) : '∞';
    const adjHf = Number.isFinite(state.adjustedHF) ? state.adjustedHF.toFixed(2) : '∞';
    lines.push(
      `${state.currentZone.emoji} <code>${addr}</code> · ${state.loanId}`,
      `   HF: <b>${hf}</b> · Adj: <b>${adjHf}</b> · Zone: ${state.currentZone.label}`,
      '',
    );
  }

  if (status.lastPollAt) {
    lines.push(`Last updated: ${fmtDateWithRelative(status.lastPollAt)}`);
  }
  if (status.lastError) {
    lines.push(`Last error: ${status.lastError}`);
  }

  return lines.join('\n');
}

telegram.onCommand('status', async (chatId) => {
  const status = monitor.getStatus();
  await telegram.sendMessage(chatId, formatStatusMessage(status, storage.get().zones));
});

telegram.onCommand('refresh', async (chatId) => {
  await telegram.sendMessage(chatId, 'Refreshing loan data...');
  try {
    const status = await monitor.refreshState();
    await telegram.sendMessage(chatId, formatStatusMessage(status, storage.get().zones));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await telegram.sendMessage(chatId, `Refresh failed: ${message}`);
  }
});

telegram.onCommand('watchdog', async (chatId) => {
  const summary = monitor.watchdog.getStatusSummary();
  const log = monitor.watchdog.getLog();
  await telegram.sendMessage(chatId, formatWatchdogStatusMessage(summary, log));
});

telegram.onCommand('help', async (chatId) => {
  await telegram.sendMessage(
    chatId,
    [
      '<b>Aave Loan Monitor</b>',
      '',
      ...TELEGRAM_BOT_COMMANDS.map((command) => `/${command.command} — ${command.description}`),
    ].join('\n'),
  );
});

// Serve frontend static files (built by Vite, copied into /app/public in Docker)
const publicDir = join(__dirname, '..', '..', '..', 'public');
if (existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(join(publicDir, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Aave monitor server listening on port ${PORT}`);
  syncRuntimeServices();
});
