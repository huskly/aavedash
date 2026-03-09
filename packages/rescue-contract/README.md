# Rescue Contract (Foundry)

This package contains the v1 atomic Aave rescue contract.

## Contents

- `src/AaveAtomicRescueV1.sol` - owner-only atomic rescue executor
- `script/DeployAaveAtomicRescueV1.s.sol` - deploy script
- `test/AaveAtomicRescueV1.t.sol` - unit tests with mocks

## Commands

```bash
forge build --root packages/rescue-contract
forge test --root packages/rescue-contract
forge script script/DeployAaveAtomicRescueV1.s.sol --root packages/rescue-contract --rpc-url $RPC_URL --broadcast
```
