# v1 Plan — Atomic Aave Rescue via Collateral Top-Up

## Project Goal

Maximize productive capital while preserving tax cleanliness and liquidation safety by supplying WETH/WBTC on Aave and borrowing USDC against it, then using the borrowed USDC for higher-yield external deployment. The rescue system should prioritize **non-taxable, operationally simple, on-chain protection** over maximum capital efficiency. :contentReference[oaicite:0]{index=0}

---

## Executive Summary

Build a **v1 atomic rescue system** for an Aave position that improves Health Factor (HF) by **adding collateral**, not by selling collateral.

This is a deliberate design choice.

### Why this design

- Selling collateral likely creates a taxable disposition.
- Keeping large idle USDC balances is yield-inefficient.
- Adding collateral is cleaner from a tax and systems perspective.
- An atomic top-up is much simpler and safer to implement than a flash-loan deleveraging engine.

### v1 objective

When HF falls below a configured trigger, the system should submit **one on-chain transaction** that:

1. pulls approved reserve assets from a designated wallet or vault,
2. supplies them to Aave as collateral,
3. enables collateral if needed,
4. verifies resulting HF meets a minimum target,
5. reverts if the rescue is insufficient.

This should be the default rescue path.

---

## Design Principles

1. **Tax cleanliness first**
   - Avoid selling WETH/WBTC collateral in normal operation.
   - Avoid swap-based deleveraging in v1.
   - Treat taxable collateral sale as future emergency-only functionality.

2. **Atomicity**
   - Rescue must be one on-chain transaction.
   - No multi-tx sequence like withdraw → approve → repay.
   - Either the rescue fully succeeds or nothing changes.

3. **Operational simplicity**
   - Start narrow.
   - One protocol: Aave v3.
   - One chain: mainnet only.
   - One rescue action: add collateral.

4. **Capital productivity**
   - Do not require large idle stablecoin balances as the primary safety mechanism.
   - Preserve capacity to keep capital deployed in higher-yield strategies elsewhere.

5. **Conservative automation**
   - v1 should trigger earlier than a repay/delever bot would.
   - Collateral top-up is less capital-efficient than debt paydown, so it needs more buffer.

---

## Scope of v1

### In scope

- Aave v3 mainnet position monitoring
- Trigger evaluation based on HF
- Atomic on-chain collateral top-up
- Support for reserve asset transfer from wallet or reserve vault
- Post-action HF verification
- Owner-only or approved-operator-only execution
- Strong logging, simulation, and dry-run support
- Safe defaults and configurable thresholds

### Out of scope

- Flash loans
- Selling collateral
- DEX swaps
- Multi-step repay flows
- Cross-chain funding
- TradFi account movement
- Portfolio optimization
- Generic public keeper network
- Multi-protocol support
- Full autonomous fund management

---

## Core Rescue Philosophy

### Primary rescue path

**Add collateral atomically**

This is the default rescue action.

### Secondary rescue path

Optional future extension:

- repay debt from idle reserve USDC already on-chain

### Tertiary rescue path

Optional future extension:

- withdraw pre-supplied reserve USDC and repay debt atomically

### Emergency-only path

Future, explicit opt-in only:

- sell collateral / flash-loan deleveraging / taxable rescue

---

## High-Level Architecture

### 1. Off-chain Monitor / Planner

Responsibilities:

- poll Aave account state
- compute current HF, collateral, debt, liquidation distance
- determine whether rescue is needed
- choose rescue asset and amount
- simulate expected post-rescue HF
- submit one rescue tx if thresholds are met

The off-chain system should become a **planner and tx submitter**, not a multi-step executor.

### 2. On-chain Rescue Executor

A dedicated contract that performs the atomic rescue.

Responsibilities:

- pull approved rescue asset from wallet or reserve vault
- supply asset into Aave
- enable collateral if required
- read resulting account state
- require resulting HF >= configured minimum
- revert if rescue is insufficient

---

## Why Collateral Top-Up Instead of Repay

### Benefits

- avoids selling appreciated crypto collateral
- avoids swap-based taxable disposition
- simpler than flash-loan deleveraging
- no DEX routing risk
- no slippage logic required
- easier to test and reason about
- cleaner failure modes

### Tradeoff

- less capital-efficient than repaying debt
- requires earlier trigger thresholds
- requires reserve assets to be available on-chain

This is an acceptable tradeoff for v1.

---

## Reserve Asset Strategy

v1 should support adding collateral from reserve assets.

### Preferred reserve asset order

1. **USDC**
   - best for predictable HF improvement
   - stable
   - clean collateral top-up
2. **WETH**
   - acceptable fallback
   - liquid
   - operationally simple
3. **WBTC**
   - optional fallback
   - support later if needed

### v1 recommendation

Implement support in this order:

1. USDC top-up
2. WETH top-up
3. WBTC top-up

### Important note

USDC is the best rescue collateral from a risk-management perspective, but the system should not force large idle USDC balances as a requirement. Reserve design is a portfolio-level decision, not just a contract-level one.

---

## Trigger Policy

Because v1 uses **collateral-add rescue**, not debt repayment, thresholds should be more conservative.

### Suggested v1 thresholds

- **Trigger HF:** 1.6 - 1.7
- **Target HF after rescue:** 1.9
- **Minimum acceptable resulting HF:** configurable, default around 1.85

### Rationale

Collateral top-up improves HF less efficiently than debt repayment. Waiting until HF 1.25 is too late for this rescue style unless reserve capital is very large.

---

## Functional Requirements

### FR1 — Monitor Aave account state

The system must read:

- total collateral
- total debt
- current HF
- asset composition
- reserve wallet balances
- reserve allowances / approvals if relevant

### FR2 — Decide whether rescue is needed

The planner must compare current HF against configured thresholds.

### FR3 — Choose rescue asset

The planner must choose the rescue asset according to configuration and availability.

### FR4 — Calculate required collateral top-up

The planner must estimate how much of the rescue asset is needed to bring HF to target.

### FR5 — Simulate rescue outcome

Before submission, the planner must estimate post-action HF.

### FR6 — Submit one transaction

The planner must submit exactly one atomic rescue tx.

### FR7 — Atomic supply

The contract must:

- receive or pull reserve asset
- approve Aave if needed
- call `supply`
- enable collateral if needed
- verify resulting HF
- revert if insufficient

### FR8 — Strong access control

Only authorized actors may trigger rescue.

### FR9 — Observability

The system must emit logs and metrics for:

- rescue decision
- selected asset
- size
- expected HF
- actual HF after execution
- failure reason

---

## Contract Design — v1

### Candidate interface

```solidity
struct RescueParams {
    address user;
    address asset;
    uint256 amount;
    uint256 minResultingHF;
    uint256 deadline;
}

function rescue(RescueParams calldata params) external;
```

### Expected behavior

1. validate caller authorization
2. validate deadline
3. pull `asset` from approved wallet or vault
4. approve Aave Pool if necessary
5. supply asset on behalf of `user`
6. enable collateral if required
7. read Aave account data
8. require resulting HF >= `minResultingHF`
9. revert otherwise

### Notes

- avoid generic complexity
- owner-only is fine for v1
- keep external integrations minimal
- do not over-generalize the contract

---

## Planner Logic — v1

### Planner input

- current HF
- target HF
- trigger HF
- current reserve balances
- supported rescue assets
- asset priority rules
- Aave parameters

### Planner output

- rescue needed: yes/no
- selected asset
- amount to supply
- projected resulting HF
- tx calldata

### Planner rules

- no rescue if HF above trigger
- no rescue if projected HF after action is below minimum
- no rescue if reserve asset balance is insufficient
- prefer simplest valid action
- no partial ambiguous execution paths
- fail closed

---

## Safety Invariants

These must hold.

1. **No collateral sales in v1**
   - contract must not swap or sell assets

2. **Single-tx execution**
   - rescue is atomic

3. **Post-HF assertion**
   - tx must revert if resulting HF is below configured minimum

4. **Restricted caller**
   - only authorized operator(s)

5. **Deadline required**
   - prevent stale execution

6. **No open-ended approvals unless explicitly accepted**
   - ideally limit approvals or carefully document approval model

7. **No hidden side effects**
   - rescue only supplies collateral and updates collateral enablement as needed

---

## Failure Modes to Handle

### Acceptable failures

- insufficient reserve asset
- stale tx / deadline exceeded
- resulting HF too low
- Aave revert
- gas / RPC issues
- approval failure
- unsupported asset

### Unacceptable failures

- partial state changes outside atomic rescue
- rescue tx succeeds but HF remains below safety threshold
- unauthorized rescue execution
- rescue path accidentally sells collateral
- ambiguous planner behavior that oscillates or thrashes

---

## Implementation Phases

### Phase 1 — Spec and architecture

Deliverables:

- written design spec
- contract interface
- planner algorithm
- risk policy defaults
- event/logging schema

### Phase 2 — Contract implementation

Deliverables:

- minimal rescue executor contract
- tests for supply path
- tests for HF post-check
- tests for authorization and deadline behavior

### Phase 3 — Planner refactor

Deliverables:

- current bot refactored into monitor/planner/submitter
- rescue asset selection logic
- amount calculation logic
- projected HF logic
- dry-run / simulation mode

### Phase 4 — Integration testing

Deliverables:

- local fork tests against Aave mainnet state
- scenario tests with falling HF
- insufficient reserve tests
- stale config tests
- successful rescue tx validation

### Phase 5 — Hardening

Deliverables:

- observability
- retry / tx replacement policy
- runbooks
- deployment scripts
- config validation
- kill switch / pause path

---

## Testing Requirements

### Unit tests

- authorization
- deadline expiry
- approval behavior
- supply behavior
- collateral enablement behavior
- post-HF validation

### Integration tests

- forked mainnet tests
- existing live-style Aave position shapes
- rescue with USDC
- rescue with WETH
- insufficient top-up scenarios
- target HF achievable vs not achievable

### Scenario tests

- HF 1.75 → top-up to 2.0
- HF 1.60 → top-up to 1.9
- HF 1.45 with insufficient reserve → revert
- reserve asset disabled as collateral → handle correctly
- repeated trigger attempts / cooldown logic

---

## Observability and Ops

The system should log:

- current HF
- trigger threshold
- selected reserve asset
- amount chosen
- projected resulting HF
- tx hash
- final actual HF
- failure reason
- reserve balances before/after

Add operator-facing alerts for:

- HF entering watch/alert/action states
- rescue tx submitted
- rescue tx confirmed
- rescue tx reverted
- reserve asset running low

---

## Configuration

Recommended config fields:

- chain id
- Aave pool address
- monitored account
- trigger HF
- target HF
- minimum acceptable resulting HF
- reserve asset priority list
- allowed rescue assets
- max rescue amount per asset
- operator address(es)
- deadline window
- polling interval
- dry-run mode
- pause switch

---

## Non-Goals for v1

Do not attempt these in v1:

- generalized strategy engine
- flash-loan deleveraging
- tax optimization engine
- tradfi integration
- on-chain swaps
- price routing / slippage handling
- multi-user keeper protocol
- full smart-account migration
- composable vault ecosystem

Keep v1 narrow and correct.

---

## Recommended v1 Deliverable

A production-usable but narrow system that can:

- monitor one Aave account,
- detect HF deterioration,
- compute a collateral top-up,
- execute one atomic rescue transaction,
- verify improved HF,
- avoid taxable collateral sales,
- and fail safely if rescue is not possible.

---

## Future Extensions

Only after v1 is stable:

### v2

- repay from idle reserve USDC atomically

### v3

- withdraw pre-supplied reserve USDC and repay atomically

### v4

- optional emergency taxable deleveraging via flash-loan rescue

### v5

- smart-account / proxy based recipe execution

---

## Instructions for the LLM Agent

Your task is to plan and implement **v1 only**.

### Priorities

1. correctness
2. atomicity
3. safety
4. simplicity
5. observability

### Constraints

- do not introduce collateral sale logic
- do not introduce flash loans
- do not introduce swap logic
- do not over-engineer abstractions
- do not generalize beyond the single-account Aave v3 mainnet use case unless necessary

### Output expected from the agent

1. proposed repo/file changes
2. contract design
3. planner design
4. test plan
5. implementation plan by milestone
6. concrete code changes for v1
7. known risks and open questions

### Standard for completion

The agent should produce a narrow, testable, mainnet-fork-validated v1 implementation of atomic collateral top-up rescue.

---

```

If you want, I can also turn this into a tighter **AGENTS.md-style execution brief** with explicit tasks, acceptance criteria, and file-by-file implementation hints.
```
