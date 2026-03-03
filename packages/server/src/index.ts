import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ConfigStorage, type AlertConfig, type WalletConfig, type ZoneConfig } from './storage.js';
import { TelegramClient } from './telegram.js';
import { Monitor } from './monitor.js';

const ZONE_NAMES = new Set(['safe', 'watch', 'alert', 'action', 'critical']);

function parseConfigBody(body: unknown): { data: Partial<AlertConfig> } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }
  const raw = body as Record<string, unknown>;
  const result: Partial<AlertConfig> = {};

  if ('wallets' in raw) {
    if (!Array.isArray(raw.wallets)) return { error: '"wallets" must be an array' };
    const wallets: WalletConfig[] = [];
    for (const w of raw.wallets) {
      if (typeof w !== 'object' || w === null) return { error: '"wallets" items must be objects' };
      const wObj = w as Record<string, unknown>;
      if (typeof wObj.address !== 'string')
        return { error: '"wallets[].address" must be a string' };
      if (typeof wObj.enabled !== 'boolean')
        return { error: '"wallets[].enabled" must be a boolean' };
      if ('label' in wObj && wObj.label !== undefined && typeof wObj.label !== 'string')
        return { error: '"wallets[].label" must be a string' };
      wallets.push({
        address: wObj.address,
        enabled: wObj.enabled,
        label: wObj.label as string | undefined,
      });
    }
    result.wallets = wallets;
  }

  if ('telegram' in raw) {
    const t = raw.telegram;
    if (typeof t !== 'object' || t === null) return { error: '"telegram" must be an object' };
    const tObj = t as Record<string, unknown>;
    if (typeof tObj.chatId !== 'string') return { error: '"telegram.chatId" must be a string' };
    if (typeof tObj.enabled !== 'boolean') return { error: '"telegram.enabled" must be a boolean' };
    result.telegram = { chatId: tObj.chatId, enabled: tObj.enabled };
  }

  if ('polling' in raw) {
    const p = raw.polling;
    if (typeof p !== 'object' || p === null) return { error: '"polling" must be an object' };
    const pObj = p as Record<string, unknown>;
    for (const key of [
      'intervalMs',
      'debounceChecks',
      'reminderIntervalMs',
      'cooldownMs',
    ] as const) {
      if (
        typeof pObj[key] !== 'number' ||
        !Number.isFinite(pObj[key]) ||
        (pObj[key] as number) <= 0
      )
        return { error: `"polling.${key}" must be a positive non-zero number` };
    }
    result.polling = {
      intervalMs: pObj.intervalMs as number,
      debounceChecks: pObj.debounceChecks as number,
      reminderIntervalMs: pObj.reminderIntervalMs as number,
      cooldownMs: pObj.cooldownMs as number,
    };
  }

  if ('zones' in raw) {
    if (!Array.isArray(raw.zones)) return { error: '"zones" must be an array' };
    const zones: ZoneConfig[] = [];
    for (const z of raw.zones) {
      if (typeof z !== 'object' || z === null) return { error: '"zones" items must be objects' };
      const zObj = z as Record<string, unknown>;
      if (typeof zObj.name !== 'string' || !ZONE_NAMES.has(zObj.name))
        return { error: `"zones[].name" must be one of: ${[...ZONE_NAMES].join(', ')}` };
      if (typeof zObj.minHF !== 'number' || !Number.isFinite(zObj.minHF))
        return { error: '"zones[].minHF" must be a number' };
      if (
        typeof zObj.maxHF !== 'number' ||
        (!Number.isFinite(zObj.maxHF) && zObj.maxHF !== Infinity)
      )
        return { error: '"zones[].maxHF" must be a number' };
      zones.push({
        name: zObj.name as ZoneConfig['name'],
        minHF: zObj.minHF as number,
        maxHF: zObj.maxHF as number,
      });
    }
    result.zones = zones;
  }

  return { data: result };
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

app.options('*', (_req, res) => {
  res.sendStatus(204);
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
