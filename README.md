# CushionStellar

Capital-protected strategy vaults on Stellar. This repo contains:

- A **Next.js frontend** - vault dashboard, wallet connection, deposit/withdraw UI
- A **Soroban smart contract** - SEP-41 token + SEP-56 vault with on-chain strategy safety checks
- An **indexer** - Fastify API and poller that turns onchain events into vault metrics
- A **strategy engine** - Python service that computes the capital-protected allocation, with its backtest
- **Safeguard checks** - scripts that verify the onchain guardrails against a deployed vault

## Architecture overview

The frontend connects to Stellar wallets and displays vault state. The smart contract lives on Soroban and handles all deposit/withdraw/strategy logic on-chain.

- **Frontend**: Next.js 15 / React 19 / TypeScript / Tailwind CSS / Stellar Wallets Kit
- **Contract**: Rust / Soroban SDK 26.1 / `wasm32v1-none` target
- **State management**: Zustand + Immer for wallet state
- **UI primitives**: Radix UI (popover, tooltip, toggle)

## Project structure

```
src/
  app/
    page.tsx                  → Root page (redirects to vault)
    layout.tsx                → Root layout
    vaults/
      layout.tsx              → Vaults layout
      [vaultId]/page.tsx      → Vault dashboard page
  components/
    stellar/                  → Wallet provider, connect button, SSR guard
    ui/                       → Radix-based UI primitives (button, input, popover, etc.)
    Footer.tsx                → Footer component
  stores/
    useStellarWalletStore.ts  → Zustand store (address, connected)
  constants/
    stellarVaults.ts          → Vault definitions (name, asset, decimals, description)
  lib/
    utils.ts                  → Utility helpers

contracts/
  strategy-vault/
    src/
      lib.rs                  → Public contract interface
      vault.rs                → Share math + multi-asset NAV (the chokepoint)
      strategy.rs             → Strategy execution + safeguards
      events.rs               → Onchain event schema (#[contractevent])
      oracle.rs               → Reflector (SEP-40) integration + circuit breaker
      storage.rs              → Storage keys, StrategyConfig, TTL helpers
      errors.rs               → Error enum
      test.rs                 → 63 tests (~96% coverage)
    Cargo.toml                → Soroban SDK 26.1.0 + OZ Pausable
  test-router/                → Testnet-only adapter for the safeguard checks (not a DEX)
  test-oracle/                → Testnet-only mock SEP-40 feed for the safeguard checks

cppi-engine/                  → Strategy engine (FastAPI): CPPI allocation with ratchet steps
  strategy.py                 → cppi_strategy(), ratchet_floor()
  main.py                     → POST /strategy/stellar, GET /health
  backtest/                   → Binance price download + grid backtest, results as PDF/CSV
  tests/                      → Strategy math and API tests

safeguard-checks/             → Scripts that check the onchain guardrails on testnet
```

## Smart contract

The contract implements two Stellar standards:

**SEP-41 (Token)** - vault shares are transferable tokens with `balance`, `transfer`, `approve`, `transfer_from`, `burn`, `burn_from`.

**SEP-56 (Vault)** - full vault interface: `deposit`, `withdraw`, `redeem`, `mint`, plus preview and conversion functions. Rounding favors the vault (down on deposit/redeem, up on withdraw/mint).

**Strategy execution** (`execute_strategy`) - operator-restricted trades guarded, in order, by: access control → **nonce** (strict, monotonic replay protection) → **deadline** (ledger timestamp) → token allowlist → **router allowlist** (only vetted DEX adapters) → trade-size cap → cooldown → swap → **slippage** (`min_amount_out`, operator floor) → **oracle slippage cap** (`max_slippage_bps`: realized output must clear the oracle-implied minimum, a hard bound the operator cannot loosen) → **floor guardrail**. Emits a `strategy` event with `nav_before`/`nav_after`.

**Multi-asset NAV** - `total_assets()` returns `base_balance + Σ(risky_balanceᵢ × oracle_priceᵢ)`, valued in the base asset. It is the single chokepoint every conversion/preview funnels through, so share price reflects the whole portfolio. It is a *live* read of balances + oracle prices, never a stored number.

**Oracle (Reflector, SEP-40)** - `get_safe_price` computes the USD cross-rate from `lastprice` and **reverts** on a stale quote, an unavailable quote, or a deviation beyond `deviation_bps` between `lastprice` and the mean of recent `prices()` records (a deviating oracle can therefore never produce a trade). The vault never accepts an executor-supplied price. Reflector is the primary source in Tranche 1; a DEX-TWAP primary layer (Soroswap/Phoenix pools) lands with the DEX adapters in Tranche 2, demoting the external feed to a sanity check per the target architecture.

**Floor guardrail** - a strategy trade reverts if it would push the base-asset allocation below `floor_bps` of NAV (capital-protection floor, enforced at execution time).

**Emergency pause (OZ Pausable)** - a guardian (or admin) can `pause`/`unpause`. Pause halts `deposit`/`mint`/`execute_strategy`; `withdraw`/`redeem` stay callable.

**User Exit Guarantee** - `withdraw`/`redeem` read real onchain balances. When the vault holds only base (the keeper-maintained buffer), they always succeed regardless of strategy or oracle state.

**Virtual offset** - `decimals_offset` (config) hardens against share inflation / rounding attacks on empty vaults.

**Fees** - management (`mgmt_fee_bps`, per year) and performance (`perf_fee_bps`, on profit above a **high-water mark**) fees accrue via permissionless `collect_fees()`, paid by minting shares to the fee recipient (dilution). Both default to 0 until parameters are set per deployment.

### Event schema (frozen - the indexer is built against it)

| Event | Topics | Data |
|---|---|---|
| `deposit` | `[deposit, from, receiver]` | `[assets, shares]` |
| `withdraw` | `[withdraw, owner, receiver]` | `[assets, shares]` |
| `transfer` | `[transfer, from, to]` | `amount` |
| `approve` | `[approve, from, spender]` | `[amount, expiration_ledger]` |
| `burn` | `[burn, from]` | `amount` |
| `strategy` | `[strategy, operator]` | `[nonce, token_in, token_out, amount_in, amount_out, nav_before, nav_after]` |
| `paused` / `unpaused` | per OZ Pausable | - |

> Note: there is intentionally **no** `circuit_broken` event - the oracle halt is a revert, and Soroban rolls back events on revert, so the durable signal is the `OracleDeviation`/`OracleStale` error on the failed transaction.

### Config (`StrategyConfig`)

`max_trade_size` (base units) · `cooldown_period` (s) · `allowed_tokens` (swap allowlist) · `allowed_routers` (venue allowlist) · `max_slippage_bps` (hard onchain cap vs oracle price) · `floor_bps` (min base % of NAV) · `reflector_id` (oracle) · `asset_symbols` (token → Reflector ticker) · `deviation_bps` · `staleness` (s) · `decimals_offset` · `mgmt_fee_bps` · `perf_fee_bps`. Risk parameters are set deliberately per deployment, not defaulted.

### Build & deploy (stellar-cli)

```sh
# Zero-warning wasm build (the OZ crates require stellar-cli ≥ 25.2.0)
cd contracts/strategy-vault && stellar contract build
# Coverage
cargo llvm-cov --summary-only
# Deploy to testnet
stellar contract deploy --wasm ../../target/wasm32v1-none/release/strategy_vault.wasm \
  --source <identity> --network testnet
```

## How to run the frontend

Prerequisites: Node.js, pnpm

```sh
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). The root page redirects to the vault dashboard.

## How to build the contract

Prerequisites: Rust (pinned via `rust-toolchain.toml`), `wasm32v1-none` target

```sh
# Add the WASM target (once) - rust-toolchain.toml also installs it automatically
rustup target add wasm32v1-none

# Run tests
cd contracts/strategy-vault
cargo test

# Build optimized WASM (zero warnings)
cargo build --target wasm32v1-none --release
```

## Indexer (`indexer/`)

A single Railway-style service - **Fastify API + embedded `node-cron` poller + Prisma + Postgres** - that indexes the vault's onchain events and serves vault metrics to the dashboard.

- **Ingest:** each cycle pulls Soroban `getEvents` for the vault contract, decodes base64 XDR (`scValToNative`), and upserts on the event TOID (idempotent - re-ingest yields zero duplicates). Maintains `user_position` from share-moving events.
- **Snapshots/metrics:** reads `total_assets` (NAV) / `total_supply` / balances via RPC each cycle → TVL, allocation split, trailing share-price performance + APY.
- **API:** `GET /vaults/:id/stats`, `/vaults/:id/history?range=`, `/users/:address/positions` (p95 < 1s on indexed Postgres).
- **Dashboard:** `src/app/vaults/[vaultId]/page.tsx` reads this API (`src/services/indexer.ts`, `src/hooks/useVaultData.ts`) - TVL, allocation, and positions come from indexed data, not live RPC.

```sh
cd indexer
cp .env.example .env          # set DATABASE_URL + VAULT_CONTRACT_ID
pnpm install
pnpm migrate:dev              # create tables
pnpm dev                      # Fastify on :8080, polls every CRON_INTERVAL_SECONDS
```

Set `NEXT_PUBLIC_INDEXER_URL` (default `http://localhost:8080`) for the frontend. Env vars: see `indexer/.env.example`.

## Strategy engine (`cppi-engine/`)

A FastAPI service that computes the target allocation. It holds no keys and moves no funds: the orchestrator sends the vault state, and the engine answers with percentages and a limit order price. The vault enforces its own rules onchain whatever the engine returns.

**CPPI with ratchet steps.** The risky exposure is `multiplier x cushion`, where the cushion is the value above the protected floor. Each gain of `profit_lockin x initial capital` raises the floor by one step, and the floor never comes down.

- `POST /strategy/stellar` - body: `price_risky`, `price_safe`, `nav`, `max_nav`, `risky_amount`, `safe_amount`, `initial_capital`. It returns the target percentages, the limit order price, and the values the caller must store (`newMaxNav`, `floorValue`, `ratchetSteps`).
- The four risk parameters come only from the environment. The service refuses to start without them, so a deployment always states them.

```sh
cd cppi-engine
poetry install
cp .env.example .env          # set the four CPPI_* values
poetry run pytest
poetry run uvicorn main:app
```

**Backtest (`cppi-engine/backtest/`).** `fetch_prices.py` downloads XLM candles from Binance for a fixed period, and `run_backtest.py` runs the strategy at each of the 24 rebalance hours over a parameter grid, for a safe leg at 0% and at 6%. It writes a PDF per case, a CSV of every parameter set, and a JSON summary under `backtest/results/`. The tests check that the vectorized backtest gives the same result as the engine that ships.

```sh
poetry install --with backtest
poetry run python backtest/run_backtest.py
```

## Safeguard checks (`safeguard-checks/`)

Scripts that call the deployed vault with one broken input at a time and check that it rejects the call with the expected error code.

- `run_checks.sh` - runs against the product vault. It only simulates, so it changes nothing.
- `run_scenarios.sh` - runs against a separate test vault and covers every guardrail, plus the emergency pause and one accepted swap. It restores the vault at the end.

Each script writes a JSON report with the case, the expected code, and the code that the network returned.

Two contracts exist only for these checks, on testnet: `contracts/test-router` pays a price that the test chooses, and `contracts/test-oracle` returns a quote with a chosen age and history. **Neither is a DEX or a price source**, and no product vault allowlists them. They exist because the slippage cap, the floor check, and the oracle breaker cannot be exercised onchain without a counterparty that pays a bad price and a feed that can be made stale.

## Tech stack

| Layer     | Technology                                |
| --------- | ----------------------------------------- |
| Framework | Next.js 15                                |
| Language  | TypeScript / Rust                         |
| Wallet    | Stellar Wallets Kit (beta)                |
| Styling   | Tailwind CSS 3                            |
| State     | Zustand 5 + Immer                         |
| UI        | Radix UI                                  |
| Contract  | Soroban SDK 26.1 + OZ Pausable           |
| Strategy  | Python 3.13 + FastAPI (CPPI engine)       |
| Indexer   | Fastify + Prisma + Postgres + node-cron   |
| Standards | SEP-41 (token), SEP-56 (vault), SEP-40 (oracle) |
