# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
yarn dev           # start Vite dev server (localhost:5173)
yarn build         # tsc -b && vite build (production)
yarn preview       # preview production build
yarn typecheck     # frontend + backend workspace TypeScript checks
yarn lint          # eslint
yarn format        # prettier --write
yarn format:check  # prettier --check
yarn test          # server watchdog/config tests (node:test via tsx)
```

Always run `typecheck`, `lint`, and `format` before finishing changes. Also make sure you check
instructions in AGENTS.md if you haven't already.

## Environment Variables

Configured via `.env` in project root (prefixed with `VITE_` for Vite exposure):

- `VITE_THE_GRAPH_API_KEY` — required for multi-market subgraph access
- `VITE_COINGECKO_API_KEY` — optional, avoids CoinGecko rate limits
- `VITE_R_DEPLOY` — optional deploy APY rate (decimal, default 0.1125)
- `VITE_BASE_PATH` — used in vite.config.ts for GitHub Pages deployment
- `RPC_URL` — Ethereum JSON-RPC endpoint used by backend for on-chain reads (default `https://eth.llamarpc.com`)
- `WATCHDOG_PRIVATE_KEY` — optional private key for watchdog live mode (auto-repay); omit for dry-run only
- `TELEGRAM_BOT_TOKEN` — backend Telegram bot token (loaded from root `.env`)
- `PORT` — optional backend port (default `3001`)

Backend server notes:

- `packages/server` auto-loads the root `.env` on startup.
- Backend Graph/CoinGecko keys are read from `VITE_THE_GRAPH_API_KEY` and `VITE_COINGECKO_API_KEY` (legacy non-`VITE_` names still work as fallback).
- `POST /api/status/refresh` forces an immediate monitor recomputation and returns fresh `/api/status` payload.
- Telegram `/status` includes portfolio average health factor, Net APY, total collateral, total debt, portfolio borrow power used, and cash margin of safety (USD and %) alongside per-loan health factors. Telegram alerts include per-asset liquidation prices for each collateral asset.
- Telegram `/status` includes `Last updated` with absolute timestamp + relative time (e.g. `3 minutes ago`).
- Reminder alerts include a human-readable elapsed duration label (e.g. `2h 40m ago`).
- Fully paid-off / zero-value positions are filtered out of both dashboard data and Telegram status output.
- Watchdog user-facing docs live in `docs/watchdog-user-manual.md`.
- Watchdog is fully wired: monitor integration, `GET /api/watchdog/status` endpoint, `/watchdog` Telegram command, and config via `GET/PUT /api/config`.

Frontend notes:

- `src/App.tsx` stores the last successfully loaded wallet under `localStorage['aave-monitor:last-wallet']`.
- On page load, wallet resolution order is: query string (`wallet`, `address`, `walletAddress`) first, then saved local storage wallet.

## Architecture

This is a single-page React 19 + TypeScript + Vite app. Nearly all application logic lives in **`src/App.tsx`** (~1000 lines), which is a single large component containing:

- **Type definitions** — `RawUserReserve`, `AssetPosition`, `LoanPosition`, `FetchState`
- **Data fetching** — queries Aave subgraph (The Graph) for user reserves across supported markets (`proto_mainnet_v3`, `proto_lido_v3`), fetches token prices from CoinGecko
- **Loan grouping** — raw reserves are grouped into `LoanPosition` objects per borrowed asset per market
- **Metric computation** — health factor, LTV, liquidation price, leverage, borrow headroom, carry/net APY, all computed inline
- **Rendering** — portfolio-level aggregates, tabbed per-loan details, sensitivity cards, monitoring checklist

Supporting files:

- `src/main.tsx` — React entry point
- `src/styles.css` — Tailwind CSS imports
- `src/components/ui/` — shadcn/ui-style primitives (Button, Card, Badge, Input, Separator)
- `src/lib/utils.ts` — `cn()` utility (clsx + tailwind-merge)

Testing currently exists for backend watchdog/config behavior in `packages/server/test/*.test.ts` and runs with `yarn test`. There is still no routing, no state management library, and no API abstraction layer. The app is self-contained with external data coming from The Graph and CoinGecko APIs.

## Deployment

- **GitHub Pages**: automated via `.github/workflows/deploy-pages.yml` on push to `main`
- **Docker Compose**: `docker compose up --build` starts the unified app on `http://localhost:3001`
- **Docker**: single unified image where Express serves both API and frontend static files
- **hl**: `git push production master` deploys via hl with Procfile (`web: node dist/index.js`)
