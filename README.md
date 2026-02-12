# CushionStellar

Capital-protected strategy vaults on Stellar. This repo contains:

- A **Next.js frontend** — vault dashboard, wallet connection, deposit/withdraw UI
- A **Soroban smart contract** — SEP-41 token + SEP-56 vault with on-chain strategy safety checks

## Architecture overview

The frontend connects to Stellar wallets and displays vault state. The smart contract lives on Soroban and handles all deposit/withdraw/strategy logic on-chain.

- **Frontend**: Next.js 15 / React 19 / TypeScript / Tailwind CSS / Stellar Wallets Kit
- **Contract**: Rust / Soroban SDK 21.7 / `wasm32-unknown-unknown` target
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
      vault.rs                → Share math, deposit/withdraw/mint/redeem
      strategy.rs             → Strategy execution with 5 safety checks
      storage.rs              → On-chain storage keys, types, TTL helpers
      oracle.rs               → Oracle integration
      errors.rs               → Error enum
      test.rs                 → 28 tests
    Cargo.toml                → Soroban SDK 21.7.4
```

## Smart contract

The contract implements two Stellar standards:

**SEP-41 (Token)** — vault shares are transferable tokens with `balance`, `transfer`, `approve`, `transfer_from`, `burn`, `burn_from`.

**SEP-56 (Vault)** — full vault interface: `deposit`, `withdraw`, `redeem`, `mint`, plus preview and conversion functions. Rounding favors the vault (down on deposit/redeem, up on withdraw/mint).

**Strategy execution** — operator-restricted trades with 5 on-chain safety checks:

1. **Access control** — only the registered operator can call `execute_strategy`
2. **Token allowlist** — both `token_in` and `token_out` must be in the config's allowed list
3. **Trade size cap** — `amount_in` cannot exceed `max_trade_size`
4. **Cooldown** — enforces minimum time between trades
5. **Slippage check** — verifies received amount meets `min_amount_out`

**User Exit Guarantee** — `withdraw` reads the real token balance on-chain, so users can always exit regardless of strategy state.

**Virtual offset** — prevents share inflation / rounding attacks on empty vaults.

## How to run the frontend

Prerequisites: Node.js, pnpm

```sh
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). The root page redirects to the vault dashboard.

## How to build the contract

Prerequisites: Rust, `wasm32-unknown-unknown` target

```sh
# Add the WASM target (once)
rustup target add wasm32-unknown-unknown

# Run tests
cd contracts/strategy-vault
cargo test

# Build optimized WASM
cargo build --target wasm32-unknown-unknown --release
```

## Tech stack

| Layer     | Technology                     |
| --------- | ------------------------------ |
| Framework | Next.js 15                     |
| Language  | TypeScript / Rust              |
| Wallet    | Stellar Wallets Kit (beta)     |
| Styling   | Tailwind CSS 3                 |
| State     | Zustand 5 + Immer              |
| UI        | Radix UI                       |
| Contract  | Soroban SDK 21.7               |
| Standards | SEP-41 (token), SEP-56 (vault) |
