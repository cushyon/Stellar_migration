#![no_std]
//! Mock SEP-40 oracle used to validate the vault circuit breaker on testnet, and
//! to stage market moves for the stress runs.
//!
//! It is NOT a price source. The real Reflector feed cannot be forced to return a
//! stale or a deviating quote, and it cannot be asked to drop 30% on demand.
//! `age` makes a quote old (staleness check), a `history` price far from the last
//! price trips the deviation breaker, and a price per symbol stages a crash.

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, Map, Symbol, Vec};

const CFG: Symbol = symbol_short!("CFG"); // default quote
const BOOK: Symbol = symbol_short!("BOOK"); // quote per symbol

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
    /// Quote for every symbol that has no entry of its own.
    pub fn set(e: Env, price: i128, age: u64, history: i128) {
        e.storage().instance().set(&CFG, &Config { price, age, history });
        e.storage().instance().extend_ttl(100_000, 100_000);
    }

    /// Quote for one symbol, for example a crash on "TST" while "XLM" stays put.
    pub fn set_symbol(e: Env, symbol: Symbol, price: i128, age: u64, history: i128) {
        let mut book: Map<Symbol, Config> = e
            .storage()
            .instance()
            .get(&BOOK)
            .unwrap_or_else(|| Map::new(&e));
        book.set(symbol, Config { price, age, history });
        e.storage().instance().set(&BOOK, &book);
        e.storage().instance().extend_ttl(100_000, 100_000);
    }

    pub fn config(e: Env) -> Config {
        e.storage().instance().get(&CFG).unwrap()
    }

    pub fn symbol_config(e: Env, symbol: Symbol) -> Option<Config> {
        let book: Map<Symbol, Config> = e.storage().instance().get(&BOOK)?;
        book.get(symbol)
    }

    pub fn lastprice(e: Env, asset: Asset) -> Option<PriceData> {
        let cfg = quote(&e, &asset)?;
        Some(PriceData {
            price: cfg.price,
            timestamp: e.ledger().timestamp().saturating_sub(cfg.age),
        })
    }

    pub fn prices(e: Env, asset: Asset, records: u32) -> Option<Vec<PriceData>> {
        let cfg = quote(&e, &asset)?;
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

/// Quote of one asset: its own entry when it has one, the default otherwise.
fn quote(e: &Env, asset: &Asset) -> Option<Config> {
    if let Asset::Other(symbol) = asset {
        let book: Option<Map<Symbol, Config>> = e.storage().instance().get(&BOOK);
        if let Some(book) = book {
            if let Some(cfg) = book.get(symbol.clone()) {
                return Some(cfg);
            }
        }
    }
    e.storage().instance().get(&CFG)
}
