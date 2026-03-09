# Health Factor Watchdog Bot - Implementation Plan

## Context

The Aave loan monitor currently only alerts via Telegram when health factor drops. This plan adds an opt-in watchdog that can automatically repay stablecoin debt to prevent liquidation. It uses an "adjusted HF" that excludes same-asset collateral (since the bot would withdraw it to repay), ensuring the repay operation doesn't worsen the position.

**Key decisions:** env var for private key, stablecoins only, trigger at HF < 1.25, target HF >= 1.5, dry-run by default.

---

## Step 1: Add adjusted HF computation to `packages/aave-core/src/metrics.ts` DONE

Add `AdjustedHFResult` type and two pure functions:

```typescript
export type AdjustedHFResult = {
  adjustedHF: number;
  adjustedCollateralUSD: number;
  adjustedLt: number;
  sameAssetSuppliedUSD: number;
  sameAssetSuppliedAmount: number;
  debt: number;
};

export function computeAdjustedHF(loan: LoanPosition): AdjustedHFResult;
```

- Filters `loan.supplied` to exclude assets where `symbol === loan.borrowed.symbol`
- Recomputes weighted-avg liquidation threshold and collateral USD from remaining assets
- `adjustedHF = (adjustedCollateralUSD * adjustedLt) / debt`

```typescript
export function computeRepaymentAmount(
  targetHF: number,
  adjustedCollateralUSD: number,
  adjustedLt: number,
  currentDebt: number,
): number;
```

- Formula: `R = currentDebt - (adjustedCollateralUSD * adjustedLt) / targetHF`
- Returns `Math.max(0, R)`

Export both from `packages/aave-core/src/index.ts`.

---

## Step 2: Add watchdog config to `packages/server/src/storage.ts`

Add to `AlertConfig`:

```typescript
watchdog: {
  enabled: boolean; // default false
  dryRun: boolean; // default true
  triggerHF: number; // default 1.25
  targetHF: number; // default 1.5
  cooldownMs: number; // default 30 min
  maxRepayUsd: number; // default 10000
  maxGasGwei: number; // default 50
}
```

Update `DEFAULT_CONFIG` and `update()` method.

---

## Step 3: Create `packages/server/src/watchdog.ts` (new file)

Core class with:

- **`evaluate(loan, walletAddress, walletBalances)`** - main entry point called from monitor:
  1. Skip if disabled, non-stablecoin debt, or adjusted HF >= trigger
  2. Check cooldown for this loan
  3. Compute repay amount, cap at `maxRepayUsd`
  4. Source funds: wallet balance first, then withdraw same-asset supply
  5. In dry-run: log + Telegram notify what _would_ happen
  6. In live mode: call `executeRepay()`

- **`executeRepay()`** - on-chain execution:
  1. Check gas price vs `maxGasGwei`, check ETH balance for gas
  2. If withdrawing: call `Pool.withdraw(asset, amount, to)`
  3. Check/set ERC20 allowance, call `Pool.repay(asset, amount, 2, onBehalfOf)`
  4. Record tx hashes, update cooldown, Telegram notify

- Uses ethers.js v6 (`JsonRpcProvider`, `Wallet`, `Contract`) with minimal ABIs
- Aave V3 Pool: `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2`

---

## Step 4: Integrate into `packages/server/src/monitor.ts`

- Add `Watchdog` instance to `Monitor` constructor (receives `privateKey` from env)
- After existing zone-transition notification loop in `checkWallet()`, add watchdog evaluation pass:
  ```typescript
  for (const loan of loans) {
    await this.watchdog.evaluate(loan, address, walletStablecoinBalances);
  }
  ```
- Watchdog runs _after_ alerts so notifications always go out first
- Add `watchdogLog` to `MonitorStatus`

---

## Step 5: Wire up in `packages/server/src/index.ts`

- Read `WATCHDOG_PRIVATE_KEY` from env, pass to Monitor
- Add `GET /api/watchdog/status` endpoint (config + recent log + hasPrivateKey flag)
- Extend Zod validation schema for watchdog config section
- Add `/watchdog` Telegram command showing status + recent actions
- Add ethers.js dependency: `yarn workspace @aave-monitor/server add ethers`

---

## Step 6: Update `CLAUDE.md`

Document `WATCHDOG_PRIVATE_KEY` env var and watchdog config/commands.

---

## Corner Cases Handled

| Case                              | Handling                                                       |
| --------------------------------- | -------------------------------------------------------------- |
| Non-stablecoin debt               | Skip (stablecoins only)                                        |
| Insufficient funds                | Repay whatever is available, log shortfall                     |
| Multiple endangered loans         | Sequential processing; mutate balance map after each execution |
| Gas price spike                   | Skip execution, notify via Telegram                            |
| Withdraw succeeds but repay fails | Tokens stay in wallet; next poll retries after cooldown        |
| No private key set                | Dry-run works; live mode fails early with clear error          |
| Cooldown active                   | Skip, log that cooldown is in effect                           |
| No ETH for gas                    | Skip execution, notify via Telegram                            |

---

## Verification

1. `yarn typecheck && yarn lint && yarn format` pass
2. Enable watchdog in dry-run mode, set a low `triggerHF` to match a current position
3. Confirm Telegram receives dry-run notification with correct amounts
4. Test with a small `maxRepayUsd` in live mode on a test wallet
5. Verify cooldown prevents re-execution within window
6. Verify gas price check works by setting `maxGasGwei: 1`
