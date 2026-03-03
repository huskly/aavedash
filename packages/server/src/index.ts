import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
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
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const GRAPH_API_KEY = process.env.VITE_THE_GRAPH_API_KEY ?? process.env.THE_GRAPH_API_KEY;
const COINGECKO_API_KEY = process.env.VITE_COINGECKO_API_KEY ?? process.env.COINGECKO_API_KEY;

const configPath = join(__dirname, '..', 'data', 'config.json');
const storage = new ConfigStorage(configPath);
const telegram = new TelegramClient(TELEGRAM_BOT_TOKEN);
const monitor = new Monitor(telegram, () => storage.get(), GRAPH_API_KEY, COINGECKO_API_KEY);

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
  monitor.restart();
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

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`Aave monitor server listening on port ${PORT}`);

  const config = storage.get();
  if (config.telegram.enabled && config.telegram.chatId && TELEGRAM_BOT_TOKEN) {
    monitor.start();
  } else {
    console.log('Monitor not started: telegram not configured or enabled');
  }
});
