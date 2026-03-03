# Telegram Bot Notification Setup

The Aave Loan Monitor includes a backend service that polls your loan positions and sends Telegram alerts when health factor zones change.

## Prerequisites

- Node.js 18+
- A Telegram account

## 1. Create a Telegram Bot

1. Open Telegram and search for **@BotFather**.
2. Send `/newbot` and follow the prompts to name your bot.
3. BotFather will reply with a **bot token** like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`. Save this — it's your `TELEGRAM_BOT_TOKEN`.

## 2. Get Your Chat ID

You need the chat ID where the bot will send messages. This can be a private chat with the bot or a group chat.

**For a private chat:**

1. Open a conversation with your new bot in Telegram and send any message (e.g. `/start`).
2. Visit `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` in a browser.
3. Look for `"chat":{"id":123456789}` in the response. That number is your chat ID.

**For a group chat:**

1. Add the bot to the group.
2. Send a message in the group.
3. Visit the `getUpdates` URL above. Group chat IDs are negative numbers (e.g. `-1001234567890`).

## 3. Configure the Server

Use the project root `.env`:

```bash
# Required
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11

# Same API keys used by the frontend
VITE_THE_GRAPH_API_KEY=your_the_graph_api_key
VITE_COINGECKO_API_KEY=your_coingecko_api_key

# Optional (default: 3001)
PORT=3001
```

## 4. Start the Server

```bash
# Development (with auto-reload)
npm run dev:server

# Or run both frontend and server
npm run dev:all
```

The server starts on `http://localhost:3001`.

## 5. Configure via the UI

1. Set `VITE_NOTIFICATION_API_URL=http://localhost:3001` in the same root `.env` file and restart the frontend dev server.
2. A bell icon appears in the dashboard header. Click it to open the notification settings panel.
3. Enter your **Chat ID** and enable notifications.
4. Click **Test** to verify a test message arrives in Telegram.
5. Add wallet addresses to monitor.

## 6. Alternatively, Configure via API

```bash
# Set config
curl -X PUT http://localhost:3001/api/config \
  -H 'Content-Type: application/json' \
  -d '{
    "wallets": [{"address": "0xYourWallet", "label": "Main", "enabled": true}],
    "telegram": {"chatId": "123456789", "enabled": true}
  }'

# Send test message
curl -X POST http://localhost:3001/api/telegram/test

# Check monitoring status
curl http://localhost:3001/api/status

# Force immediate state refresh (recompute zones now)
curl -X POST http://localhost:3001/api/status/refresh
```

Telegram bot commands:

- `/status` prints current loans plus a portfolio summary (average health factor, Net APY, total collateral, total debt, portfolio borrow power used, cash margin of safety in USD and %).
- `/refresh` refreshes monitor state first, then prints the same enriched status output.

## Health Factor Zones

| Zone     | HF Range   | Action                           |
| -------- | ---------- | -------------------------------- |
| Safe     | > 2.0      | No action                        |
| Watch    | 1.5 – 2.0  | Monitor closely                  |
| Alert    | 1.25 – 1.5 | Prepare to act                   |
| Action   | 1.1 – 1.25 | Repay immediately                |
| Critical | < 1.1      | Emergency repay / add collateral |

Zone thresholds are configurable via the UI settings panel or the `PUT /api/config` endpoint.

## Anti-Spam Rules

- Notifications fire on **zone transitions only** — no repeats for the same zone.
- **Worsening zones** notify immediately (e.g. Watch to Alert).
- **Critical zone** bypasses debounce — instant notification.
- Other zone transitions require **2 consecutive checks** (~10 min) before alerting.
- **Recovery** sends a single message, then a 30-minute cooldown.
- If stuck in a non-safe zone for 30+ minutes, a **reminder** is sent.
- An **"All clear"** message is sent when returning to Safe.

## Docker

```bash
docker compose up --build
```

This starts both the frontend (port 80) and the monitor server (port 3001). The server reads environment variables from the project root `.env` and persists alert configuration to a Docker volume.

## API Reference

| Method | Path                  | Purpose                                                 |
| ------ | --------------------- | ------------------------------------------------------- |
| `GET`  | `/api/config`         | Get current alert configuration                         |
| `PUT`  | `/api/config`         | Update alert configuration                              |
| `POST` | `/api/telegram/test`  | Send test message                                       |
| `GET`  | `/api/status`         | Current monitoring state per loan                       |
| `POST` | `/api/status/refresh` | Force immediate monitor refresh and return latest state |
| `GET`  | `/api/health`         | Health check                                            |
