import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramClient, type TelegramBotCommand } from '../src/telegram.js';

const COMMANDS: TelegramBotCommand[] = [
  { command: 'status', description: 'Show status' },
  { command: 'help', description: 'Show help' },
];

test('syncCommands posts commands to Telegram setMyCommands endpoint', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as typeof fetch;

    const client = new TelegramClient('test-token');
    await client.syncCommands(COMMANDS);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://api.telegram.org/bottest-token/setMyCommands');
    assert.equal(calls[0]?.init?.method, 'POST');
    assert.equal(calls[0]?.init?.headers?.['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { commands: COMMANDS });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('syncCommands does not call Telegram when bot token is empty', async () => {
  let called = false;
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async () => {
      called = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const client = new TelegramClient('');
    await client.syncCommands(COMMANDS);

    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
