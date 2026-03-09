# Rescue v1 Ops (WBTC Atomic Top-Up)

## Scope

v1 supports only:

- Ethereum mainnet Aave v3
- WBTC collateral top-up rescue
- owner-only contract execution

## Deploy

From repo root:

```bash
cd packages/rescue-contract
forge build
forge test
```

Set env vars for deploy script:

```bash
export PRIVATE_KEY=...
export RESCUE_OWNER=0x...
export AAVE_POOL=0x...
export AAVE_ADDRESSES_PROVIDER=0x...
export AAVE_PROTOCOL_DATA_PROVIDER=0x...
export WBTC_ADDRESS=0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599
```

Dry-run script:

```bash
yarn deploy:rescue:dry-run --sig "run()" --rpc-url $RPC_URL
```

Broadcast:

```bash
forge script script/DeployAaveAtomicRescueV1.s.sol --root packages/rescue-contract --rpc-url $RPC_URL --broadcast
```

## Post-Deploy

1. Save deployed `AaveAtomicRescueV1` address.
2. Set `watchdog.rescueContract` in `PUT /api/config`.
3. Approve WBTC from monitored wallet to rescue contract.
4. Keep watchdog in dry-run first.
5. Switch to live mode after validation.

## Runtime Preconditions

- Monitored wallet signer key is set as `WATCHDOG_PRIVATE_KEY`.
- Signer address matches monitored wallet.
- Wallet holds WBTC and has allowance to rescue contract.
- Rescue contract has WBTC enabled as supported asset.

## Common Incident Checks

- `Invalid or missing rescueContract in watchdog config`
- `No available WBTC (balance/allowance/maxTopUp all exhausted)`
- `Insufficient WBTC to achieve minimum resulting HF`
- `Gas price ... exceeds max ...`
- `Signer address mismatch`
