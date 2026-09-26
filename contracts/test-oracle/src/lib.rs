#![no_std]
//! Mock SEP-40 oracle used to validate the vault circuit breaker on testnet.
//!
//! It is NOT a price source. The real Reflector feed cannot be forced to return a
//! stale or a deviating quote, so this contract returns quotes that a test chooses:
//! `age` makes the quote old (staleness check), and a `history` price far from the
//! last price makes the breaker trip (deviation check).

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Vec};

const CFG: Symbol = symbol_short!("CFG");

#[contracttype]
#[derive(Clone)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct Config {
    /// Price that `lastprice` returns, 14 decimals like Reflector.
    pub price: i128,
    /// Age of that quote in seconds. Above the vault `staleness`, the vault must revert.
    pub age: u64,
    /// Price of every record that `prices` returns. Far from `price` trips the breaker.
    pub history: i128,
}

#[contract]
pub struct TestOracle;

#[contractimpl]
impl TestOracle {
    pub fn set(e: Env, price: i128, age: u64, history: i128) {
        e.storage().instance().set(&CFG, &Config { price, age, history });
        e.storage().instance().extend_ttl(100_000, 100_000);
    }

    pub fn config(e: Env) -> Config {
        e.storage().instance().get(&CFG).unwrap()
    }

    pub fn lastprice(e: Env, _asset: Asset) -> Option<PriceData> {
        let cfg: Config = e.storage().instance().get(&CFG)?;
        Some(PriceData {
            price: cfg.price,
            timestamp: e.ledger().timestamp().saturating_sub(cfg.age),
        })
    }

    pub fn prices(e: Env, _asset: Asset, records: u32) -> Option<Vec<PriceData>> {
        let cfg: Config = e.storage().instance().get(&CFG)?;
        let now = e.ledger().timestamp();
        let mut out = Vec::new(&e);
        for i in 0..records {
            out.push_back(PriceData {
                price: cfg.history,
                timestamp: now.saturating_sub(i as u64 * 60),
            });
        }
        Some(out)
    }
}
