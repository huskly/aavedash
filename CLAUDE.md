# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm run dev         # start Vite dev server (localhost:5173)
npm run build       # tsc -b && vite build (production)
npm run preview     # preview production build
npm run typecheck   # frontend + backend workspace TypeScript checks
npm run lint        # eslint
npm run format      # prettier --write
npm run format:check # prettier --check
```

Always run `typecheck`, `lint`, and `format` before finishing changes.

## Environment Variables

Configured via `.env` in project root (prefixed with `VITE_` for Vite exposure):

- `VITE_THE_GRAPH_API_KEY` — required for multi-market subgraph access
- `VITE_COINGECKO_API_KEY` — optional, avoids CoinGecko rate limits
- `VITE_R_DEPLOY` — optional deploy APY rate (decimal, default 0.1125)
- `VITE_BASE_PATH` — used in vite.config.ts for GitHub Pages deployment
- `VITE_NOTIFICATION_API_URL` — frontend URL for notification server (e.g. `http://localhost:3001`)
- `TELEGRAM_BOT_TOKEN` — backend Telegram bot token (loaded from root `.env`)
- `PORT` — optional backend port (default `3001`)

Backend server notes:

- `packages/server` auto-loads the root `.env` on startup.
- Backend Graph/CoinGecko keys are read from `VITE_THE_GRAPH_API_KEY` and `VITE_COINGECKO_API_KEY` (legacy non-`VITE_` names still work as fallback).
- `POST /api/status/refresh` forces an immediate monitor recomputation and returns fresh `/api/status` payload.

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

There are no tests, no routing, no state management library, and no API abstraction layer. The app is self-contained with external data coming from The Graph and CoinGecko APIs.

## Deployment

- **GitHub Pages**: automated via `.github/workflows/deploy-pages.yml` on push to `main`
- **Docker**: multi-stage Dockerfile (node build → nginx serve)
