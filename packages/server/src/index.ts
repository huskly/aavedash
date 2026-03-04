import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import {
  classifyZone,
  DEFAULT_ZONES,
  type Zone,
  fetchStablecoinBalances,
} from '@aave-monitor/core';
import { ConfigStorage, type AlertConfig } from './storage.js';
import { TelegramClient } from './telegram.js';
import { Monitor } from './monitor.js';

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
        name: z.enum(['safe', 'watch', 'alert', 'action', 'critical']),
        minHF: z.number(),
        maxHF: z.number(),
      }),
    ),
  })
  .partial();

function parseConfigBody(body: unknown): { data: Partial<AlertConfig> } | { error: string } {
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

const configPath = join(__dirname, '..', 'data', 'config.json');
const storage = new ConfigStorage(configPath);
const telegram = new TelegramClient(TELEGRAM_BOT_TOKEN);
const monitor = new Monitor(
  telegram,
  () => storage.get(),
  GRAPH_API_KEY,
  COINGECKO_API_KEY,
  RPC_URL,
);

function syncRuntimeServices(options: { restartMonitor?: boolean } = {}): void {
  const { restartMonitor = false } = options;
  const config = storage.get();

  if (TELEGRAM_BOT_TOKEN) {
    telegram.startCommandPolling();
  } else {
    telegram.stopCommandPolling();
  }

  const shouldRunMonitor = Boolean(
    config.telegram.enabled && config.telegram.chatId && TELEGRAM_BOT_TOKEN,
  );
  if (shouldRunMonitor) {
    if (restartMonitor) {
      monitor.restart();
    } else {
      monitor.start();
    }
  } else {
    monitor.stop();
    console.log('Monitor not started: telegram not configured or enabled');
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
  });
});

app.put('/api/config', (req, res) => {
  const parsed = parseConfigBody(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const updated = storage.update(parsed.data);
  syncRuntimeServices({ restartMonitor: true });
  res.json({
    wallets: updated.wallets,
    telegram: { chatId: updated.telegram.chatId, enabled: updated.telegram.enabled },
    polling: updated.polling,
    zones: updated.zones,
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
  const fmtUsd = (value: number): string =>
    `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const fmtPct = (value: number): string => `${(value * 100).toFixed(2)}%`;

  if (!status.running) {
    return 'Monitor is not running.';
  }

  if (status.states.length === 0) {
    const lastPoll = status.lastPollAt
      ? `\nLast poll: ${new Date(status.lastPollAt).toLocaleString()}`
      : '';
    return `No active loan positions found.${lastPoll}`;
  }

  const lines: string[] = ['<b>Loan Status</b>', ''];
  const totals = status.states.reduce(
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
  const finiteHealthFactors = status.states
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

  for (const state of status.states) {
    const addr = `${state.wallet.slice(0, 6)}...${state.wallet.slice(-4)}`;
    const hf = Number.isFinite(state.healthFactor) ? state.healthFactor.toFixed(2) : '∞';
    lines.push(
      `${state.currentZone.emoji} <code>${addr}</code> · ${state.loanId}`,
      `   HF: <b>${hf}</b> · Zone: ${state.currentZone.label}`,
      '',
    );
  }

  if (status.lastPollAt) {
    lines.push(`Last updated: ${new Date(status.lastPollAt).toLocaleString()}`);
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

telegram.onCommand('help', async (chatId) => {
  await telegram.sendMessage(
    chatId,
    [
      '<b>Aave Loan Monitor</b>',
      '',
      '/status — Show portfolio totals, average health factor, and current loan health factors',
      '/refresh — Force-refresh data and show updated status',
      '/help — Show this help message',
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
