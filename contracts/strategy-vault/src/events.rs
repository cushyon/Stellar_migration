//! Onchain event emission via the `#[contractevent]` macro (soroban-sdk 26).
//!
//! Schema is a frozen interface contract — the offchain indexer is built
//! against the exact topics/data below. Any change here is an indexer change;
//! flag it loudly. See README "Event schema" / plan Appendix A.
//!
//! `data_format = "vec"` makes each event's non-topic fields an ordered
//! `Vec<Val>`, mirroring the locked tuple schema (e.g. `(assets, shares)`).
//! Single-field data uses `"single-value"` (SEP-41 transfer/burn amount).
//!
//! Events are emitted once per logical operation at the public-entrypoint
//! level. Internal helpers (`mint_shares`, `burn_shares`, `transfer_asset_*`)
//! never emit, so a single deposit/withdraw/strategy never double-counts.

use soroban_sdk::{contractevent, Address, Env};

/// `deposit` — topics `[deposit, from, receiver]`, data `[assets, shares]`.
/// Emitted by both `deposit` (assets-specified) and `mint` (shares-specified).
#[contractevent(data_format = "vec")]
pub struct Deposit {
    #[topic]
    pub from: Address,
    #[topic]
    pub receiver: Address,
    pub assets: i128,
    pub shares: i128,
}

/// `withdraw` — topics `[withdraw, owner, receiver]`, data `[assets, shares]`.
/// Emitted by both `withdraw` (assets-specified) and `redeem` (shares-specified).
#[contractevent(data_format = "vec")]
pub struct Withdraw {
    #[topic]
    pub owner: Address,
    #[topic]
    pub receiver: Address,
    pub assets: i128,
    pub shares: i128,
}

/// `transfer` — topics `[transfer, from, to]`, data `amount` (SEP-41).
#[contractevent(data_format = "single-value")]
pub struct Transfer {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

/// `approve` — topics `[approve, from, spender]`, data `[amount, expiration_ledger]` (SEP-41).
#[contractevent(data_format = "vec")]
pub struct Approve {
    #[topic]
    pub from: Address,
    #[topic]
    pub spender: Address,
    pub amount: i128,
    pub expiration_ledger: u32,
}

/// `burn` — topics `[burn, from]`, data `amount` (SEP-41).
#[contractevent(data_format = "single-value")]
pub struct Burn {
    #[topic]
    pub from: Address,
    pub amount: i128,
}

/// `strategy` — topics `[strategy, operator]`,
/// data `[nonce, token_in, token_out, amount_in, amount_out, nav_before, nav_after]`.
#[contractevent(topics = ["strategy"], data_format = "vec")]
pub struct StrategyExecuted {
    #[topic]
    pub operator: Address,
    pub nonce: u64,
    pub token_in: Address,
    pub token_out: Address,
    pub amount_in: i128,
    pub amount_out: i128,
    pub nav_before: i128,
    pub nav_after: i128,
}

// NOTE: there is intentionally no `circuit_broken` event. The oracle
// deviation/staleness halt is a revert (see oracle::get_safe_price), and
// Soroban rolls back events on revert — so such an event could never be
// durably indexed. The durable signal is the OracleDeviation/OracleStale
// error code on the failed transaction.

// ---------------------------------------------------------------------------
// Thin emit helpers — keep call sites in lib.rs/strategy.rs clean and centralize
// the schema here.
// ---------------------------------------------------------------------------

pub fn deposit(e: &Env, from: &Address, receiver: &Address, assets: i128, shares: i128) {
    Deposit {
        from: from.clone(),
        receiver: receiver.clone(),
        assets,
        shares,
    }
    .publish(e);
}

pub fn withdraw(e: &Env, owner: &Address, receiver: &Address, assets: i128, shares: i128) {
    Withdraw {
        owner: owner.clone(),
        receiver: receiver.clone(),
        assets,
        shares,
    }
    .publish(e);
}

pub fn transfer(e: &Env, from: &Address, to: &Address, amount: i128) {
    Transfer {
        from: from.clone(),
        to: to.clone(),
        amount,
    }
    .publish(e);
}

pub fn approve(e: &Env, from: &Address, spender: &Address, amount: i128, expiration_ledger: u32) {
    Approve {
        from: from.clone(),
        spender: spender.clone(),
        amount,
        expiration_ledger,
    }
    .publish(e);
}

pub fn burn(e: &Env, from: &Address, amount: i128) {
    Burn {
        from: from.clone(),
        amount,
    }
    .publish(e);
}

#[allow(clippy::too_many_arguments)]
pub fn strategy(
    e: &Env,
    operator: &Address,
    nonce: u64,
    token_in: &Address,
    token_out: &Address,
    amount_in: i128,
    amount_out: i128,
    nav_before: i128,
    nav_after: i128,
) {
    StrategyExecuted {
        operator: operator.clone(),
        nonce,
        token_in: token_in.clone(),
        token_out: token_out.clone(),
        amount_in,
        amount_out,
        nav_before,
        nav_after,
    }
    .publish(e);
}
