# Aave Loan Monitor

A React + Vite dashboard that auto-loads Aave loan positions from a wallet address and computes risk/health metrics.

## Goals

- Use a single wallet address as input.
- Fetch live position data from public blockchain indexers.
- Show all detected loans across supported Aave markets.
- Compute practical monitoring metrics (HF, LTV, liquidation, leverage, carry/net APY).

## Features

- Wallet-only input UX.
- Optional query-string wallet input (`wallet`, `address`, or `walletAddress`) with auto-fetch on load when valid.
- Manual `Refresh` button to reload the current dashboard data on demand.
- Automatic refresh every 120 seconds after a wallet is loaded.
- Multi-market support:
  - `proto_mainnet_v3`
  - `proto_lido_v3`
- Tabs for multiple loans/borrowed assets.
- Top-level portfolio metrics across all active loans (average health factor, weighted APYs, total debt/collateral/net worth).
- Portfolio average HF color bands:
  - `HF > 2.2`: normal operation (green)
  - `HF 1.8–2.2`: no new leverage, monitor closely
  - `HF 1.5–1.8`: top up collateral or reduce debt
  - `HF < 1.5`: mandatory deleveraging (red)
- Auto-fetched collateral/borrow amounts and market metadata.
- Price enrichment with CoinGecko.
- Dashboard analytics:
  - Health Factor
  - Liquidation price (primary-collateral approximation)
  - LTV, leverage, borrow headroom
  - Carry / Net APY summary
  - Monitoring checklist + sensitivity cards

## Tech Stack

- React 19
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui-style components
- Lucide icons

## Requirements

- Node.js 18+
- npm

## Environment Variables

Create `.env` in project root.

```bash
# Required for reliable multi-market Graph access (especially proto_lido_v3)
VITE_THE_GRAPH_API_KEY=your_the_graph_api_key

# Optional but recommended to avoid CoinGecko rate limits
VITE_COINGECKO_API_KEY=your_coingecko_demo_api_key

# Optional deploy APY used in carry calculations (decimal form, default: 0.1125)
VITE_R_DEPLOY=0.1125
```

Notes:

- Without `VITE_THE_GRAPH_API_KEY`, some markets may fail to load depending on endpoint availability.
- CoinGecko pricing still works without `VITE_COINGECKO_API_KEY`, but may be rate-limited.
- `VITE_R_DEPLOY` must be a non-negative decimal rate (for example, `0.1125` for 11.25%).

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Add `.env` (see above).

3. Start development server:

```bash
npm run dev
```

4. Open the local URL shown by Vite (usually `http://localhost:5173`).

5. Optional: prefill wallet from query string:

```text
http://localhost:5173/?wallet=0xYourEthereumAddress
```

Supported query params: `wallet`, `address`, `walletAddress`.

## Scripts

```bash
yarn dev           # start frontend dev server
yarn dev:server    # start backend monitor server
yarn dev:all       # start both frontend and server
yarn typecheck     # TypeScript checks (frontend + core package + server package)
yarn lint          # ESLint
yarn format        # Prettier format
yarn build         # production frontend build
yarn build:server  # production server build
yarn preview       # preview production build
```

## GitHub Pages Deployment

This project is configured to deploy automatically to GitHub Pages from `main` using GitHub Actions.

Files involved:

- `.github/workflows/deploy-pages.yml`
- `vite.config.ts` (uses `VITE_BASE_PATH` so asset URLs work under `/<repo>/`)

Setup steps:

1. Push this repo to GitHub.
2. In GitHub, open `Settings -> Pages`.
3. Set `Source` to `GitHub Actions`.
4. Add repository secrets (if needed) in `Settings -> Secrets and variables -> Actions`:
   - `VITE_THE_GRAPH_API_KEY` (recommended/usually required)
   - `VITE_COINGECKO_API_KEY` (optional)

After each push to `main`, the workflow builds the app and publishes `dist` to GitHub Pages.

## Telegram Notifications

A backend monitoring service can poll your positions and send Telegram alerts when health factor zones change (e.g. Safe → Watch → Alert → Critical). See **[docs/telegram-setup.md](docs/telegram-setup.md)** for full setup instructions.

Quick start:

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather) and get the bot token.
2. Add `TELEGRAM_BOT_TOKEN=<your token>` to the project root `.env`.
3. Run `yarn dev:server` to start the monitor.
4. Add `VITE_NOTIFICATION_API_URL=http://localhost:3001` to the same root `.env` and use the bell icon in the dashboard to configure alerts.
5. If monitor status appears stale, trigger an immediate refresh with `POST /api/status/refresh` (see docs).

## How It Works

1. User enters an Ethereum wallet address, or provides it via query string (`wallet`, `address`, or `walletAddress`).
2. App queries Aave subgraph data for supported markets.
3. Reserves are grouped into loan positions per market.
4. Token prices are fetched from CoinGecko.
5. Portfolio-level aggregate metrics are computed across all active loans.
6. Detailed metrics are computed and rendered per selected loan tab.

## Limitations

- Liquidation price is shown as a primary-collateral approximation for multi-collateral positions.
- Coverage depends on the supported market list and indexer availability.
- Metrics are simplified monitoring estimates, not a substitute for protocol-native risk engines.
- GitHub Pages deployments require proper repository secrets if API keys are needed at build time.
