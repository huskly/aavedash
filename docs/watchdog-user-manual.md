# Watchdog User Manual (Atomic Rescue v1)

This guide explains the current watchdog behavior after the breaking change to the on-chain rescue path.

## Current Behavior

The watchdog no longer runs multi-transaction repay flows.

It now acts as a planner/submission bot:

1. Reads loan health factor (HF).
2. If HF is below `triggerHF`, computes required WBTC top-up.
3. Calls the on-chain rescue contract in one transaction.
4. Contract atomically supplies WBTC collateral and enforces post-HF safety.

Rescue asset in v1 is fixed to **WBTC**.

## Why This Is Safer

- Old flow was non-atomic (`withdraw -> approve -> repay` across multiple txs).
- New flow is atomic (`rescue(...)`), so either full success or full revert.
- Contract checks resulting HF and reverts if it is below `minResultingHF`.

## Configuration

Watchdog config fields:

- `enabled` (default `false`)
- `dryRun` (default `true`)
- `triggerHF` (default `1.65`)
- `targetHF` (default `1.9`)
- `minResultingHF` (default `1.85`)
- `cooldownMs` (default `1800000`)
- `maxTopUpWbtc` (default `0.5`)
- `deadlineSeconds` (default `300`)
- `rescueContract` (required when `enabled=true`)
- `maxGasGwei` (default `50`)

Validation rules:

- `targetHF > triggerHF`
- `minResultingHF > triggerHF`
- `minResultingHF <= targetHF`
- `rescueContract` must be a valid address when watchdog is enabled

Environment overrides:

- `WATCHDOG_TRIGGER_HF`
- `WATCHDOG_TARGET_HF`
- `WATCHDOG_MIN_RESULTING_HF`
- `WATCHDOG_MAX_TOP_UP_WBTC`

## On-Chain Requirements

Live mode requires:

- `WATCHDOG_PRIVATE_KEY` set on server
- signer address matches monitored wallet
- monitored wallet has WBTC balance
- monitored wallet has approved `rescueContract` to pull WBTC

## Dry Run vs Live

Dry run:

- Computes amount and projected HF.
- Sends notifications and logs.
- No transaction submission.

Live:

- Enforces gas and ETH checks.
- Submits exactly one `rescue(...)` tx.
- Logs tx hash and applies cooldown.

## API and Telegram

- `GET /api/watchdog/status`: returns summary + recent action log
- `GET /api/config`: includes watchdog section
- `PUT /api/config`: updates watchdog fields
- `/watchdog`: shows watchdog status and recent actions

## Typical Failure Reasons

- Missing/invalid `rescueContract`
- Cooldown active
- No usable WBTC (balance/allowance/max cap)
- Projected HF cannot reach `minResultingHF`
- Gas above `maxGasGwei`
- Insufficient ETH for gas
- Signer mismatch

## Safety Checklist

- Start with `dryRun=true`.
- Configure `rescueContract` and verify address.
- Pre-approve WBTC from monitored wallet to rescue contract.
- Keep `maxTopUpWbtc` small during rollout.
- Monitor Telegram alerts and `/api/watchdog/status`.
