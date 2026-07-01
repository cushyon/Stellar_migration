# CushionStellar

Capital-protected strategy vaults on Stellar. This repo contains:

- A **Next.js frontend** — vault dashboard, wallet connection, deposit/withdraw UI
- A **Soroban smart contract** — SEP-41 token + SEP-56 vault with on-chain strategy safety checks

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
      test.rs                 → 59 tests (96% coverage)
    Cargo.toml                → Soroban SDK 26.1.0 + OZ Pausable
```

## Smart contract

The contract implements two Stellar standards:

**SEP-41 (Token)** — vault shares are transferable tokens with `balance`, `transfer`, `approve`, `transfer_from`, `burn`, `burn_from`.

**SEP-56 (Vault)** — full vault interface: `deposit`, `withdraw`, `redeem`, `mint`, plus preview and conversion functions. Rounding favors the vault (down on deposit/redeem, up on withdraw/mint).

**Strategy execution** (`execute_strategy`) — operator-restricted trades guarded, in order, by: access control → **nonce** (strict, monotonic replay protection) → **deadline** (ledger timestamp) → token allowlist → trade-size cap → cooldown → swap → **slippage** (`min_amount_out`) → **floor guardrail**. Emits a `strategy` event with `nav_before`/`nav_after`.

**Multi-asset NAV** — `total_assets()` returns `base_balance + Σ(risky_balanceᵢ × oracle_priceᵢ)`, valued in the base asset. It is the single chokepoint every conversion/preview funnels through, so share price reflects the whole portfolio. It is a *live* read of balances + oracle prices, never a stored number.

**Oracle (Reflector, SEP-40)** — `get_safe_price` fetches `lastprice`/`twap` and **reverts** on a stale quote, an unavailable quote, or a `lastprice`-vs-`twap` deviation beyond `deviation_bps` (a deviating oracle can therefore never produce a trade). The vault never accepts an executor-supplied price.

**Floor guardrail** — a strategy trade reverts if it would push the base-asset allocation below `floor_bps` of NAV (capital-protection floor, enforced at execution time).

**Emergency pause (OZ Pausable)** — a guardian (or admin) can `pause`/`unpause`. Pause halts `deposit`/`mint`/`execute_strategy`; `withdraw`/`redeem` stay callable.

**User Exit Guarantee** — `withdraw`/`redeem` read real onchain balances. When the vault holds only base (the keeper-maintained buffer), they always succeed regardless of strategy or oracle state.

**Virtual offset** — `decimals_offset` (config) hardens against share inflation / rounding attacks on empty vaults.

**Fees** — Tranche 1 ships **zero fees** as a deliberate MVP choice: `mgmt_fee_bps`/`perf_fee_bps` exist in config (forward-compatible) but are inert. Active fee accrual is Tranche 3.

### Event schema (frozen — the indexer is built against it)

| Event | Topics | Data |
|---|---|---|
| `deposit` | `[deposit, from, receiver]` | `[assets, shares]` |
| `withdraw` | `[withdraw, owner, receiver]` | `[assets, shares]` |
| `transfer` | `[transfer, from, to]` | `amount` |
| `approve` | `[approve, from, spender]` | `[amount, expiration_ledger]` |
| `burn` | `[burn, from]` | `amount` |
| `strategy` | `[strategy, operator]` | `[nonce, token_in, token_out, amount_in, amount_out, nav_before, nav_after]` |
| `paused` / `unpaused` | per OZ Pausable | — |

> Note: there is intentionally **no** `circuit_broken` event — the oracle halt is a revert, and Soroban rolls back events on revert, so the durable signal is the `OracleDeviation`/`OracleStale` error on the failed transaction.

### Config (`StrategyConfig`)

`max_trade_size` (base units) · `cooldown_period` (s) · `allowed_tokens` (swap allowlist) · `floor_bps` (min base % of NAV) · `reflector_id` (oracle) · `deviation_bps` · `staleness` (s) · `decimals_offset` · `mgmt_fee_bps` · `perf_fee_bps`. Risk parameters are set deliberately per deployment — not defaulted.

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
# Add the WASM target (once) — rust-toolchain.toml also installs it automatically
rustup target add wasm32v1-none

# Run tests
cd contracts/strategy-vault
cargo test

# Build optimized WASM (zero warnings)
cargo build --target wasm32v1-none --release
```

## Indexer (`indexer/`)

A single Railway-style service — **Fastify API + embedded `node-cron` poller + Prisma + Postgres** — that indexes the vault's onchain events and serves vault metrics to the dashboard.

- **Ingest:** each cycle pulls Soroban `getEvents` for the vault contract, decodes base64 XDR (`scValToNative`), and upserts on the event TOID (idempotent — re-ingest yields zero duplicates). Maintains `user_position` from share-moving events.
- **Snapshots/metrics:** reads `total_assets` (NAV) / `total_supply` / balances via RPC each cycle → TVL, allocation split, trailing share-price performance + APY.
- **API:** `GET /vaults/:id/stats`, `/vaults/:id/history?range=`, `/users/:address/positions` (p95 < 1s on indexed Postgres).
- **Dashboard:** `src/app/vaults/[vaultId]/page.tsx` reads this API (`src/services/indexer.ts`, `src/hooks/useVaultData.ts`) — TVL, allocation, and positions come from indexed data, not live RPC.

```sh
cd indexer
cp .env.example .env          # set DATABASE_URL + VAULT_CONTRACT_ID
pnpm install
pnpm migrate:dev              # create tables
pnpm dev                      # Fastify on :8080, polls every CRON_INTERVAL_SECONDS
```

Set `NEXT_PUBLIC_INDEXER_URL` (default `http://localhost:8080`) for the frontend. Env vars: see `indexer/.env.example`.

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
| Indexer   | Fastify + Prisma + Postgres + node-cron   |
| Standards | SEP-41 (token), SEP-56 (vault), SEP-40 (oracle) |
