#![no_std]
//! Test adapter used to validate the vault safeguards on testnet.
//!
//! It is NOT a DEX and NOT a production venue. It swaps between one base token and
//! one risky token at a price that the test sets, and it can pay a chosen amount
//! under that price. A test can then check that the vault rejects a bad fill
//! (operator slippage floor, oracle slippage cap) and that it accepts a fair one.
//! Real Soroswap or Phoenix adapters are a separate, production deliverable.

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, token, Address, Env, Symbol};

const CFG: Symbol = symbol_short!("CFG");

#[contracttype]
#[derive(Clone)]
pub struct Market {
    pub base: Address,
    pub risky: Address,
    /// Price of one risky unit in base units, in bps. 10000 = 1 base per risky.
    pub price_bps: u32,
    /// Amount paid under that price, in bps. 0 = exactly the price.
    pub slippage_bps: u32,
}

#[contract]
pub struct TestRouter;

#[contractimpl]
impl TestRouter {
    /// Set the pair, the price, and how far under the price the adapter pays.
    pub fn set_market(e: Env, base: Address, risky: Address, price_bps: u32, slippage_bps: u32) {
        e.storage().instance().set(
            &CFG,
            &Market { base, risky, price_bps, slippage_bps },
        );
        e.storage().instance().extend_ttl(100_000, 100_000);
    }

    pub fn market(e: Env) -> Market {
        e.storage().instance().get(&CFG).unwrap()
    }

    /// Same shape as the `Router` trait of the vault. The vault sends `token_in`
    /// before this call, so the adapter keeps it and pays `token_out` back.
    pub fn swap(e: Env, token_in: Address, token_out: Address, amount_in: i128, to: Address) -> i128 {
        let market: Market = e.storage().instance().get(&CFG).unwrap();
        let price = market.price_bps as i128;

        // base -> risky: the buyer gets amount_in / price. risky -> base: amount_in * price.
        let fair = if token_in == market.base {
            amount_in * 10_000 / price
        } else {
            amount_in * price / 10_000
        };
        let amount_out = fair * (10_000 - market.slippage_bps as i128) / 10_000;

        token::Client::new(&e, &token_out).transfer(&e.current_contract_address(), &to, &amount_out);
        amount_out
    }
}
