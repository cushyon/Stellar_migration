#![no_std]
//! Test adapter used to validate the vault safeguards on testnet.
//!
//! It is NOT a DEX and NOT a production venue. It pays `amount_in * rate_bps / 10000`
//! of `token_out` from its own balance, so a test can choose the realized price and
//! check that the vault rejects a bad one (slippage floor, oracle slippage cap, asset floor).
//! Real Soroswap or Phoenix adapters are a separate, production deliverable.

use soroban_sdk::{contract, contractimpl, symbol_short, token, Address, Env, Symbol};

const RATE: Symbol = symbol_short!("RATE");

#[contract]
pub struct TestRouter;

#[contractimpl]
impl TestRouter {
    /// Set the realized price, in bps of the amount that comes in. 10000 = 1:1.
    pub fn set_rate(e: Env, rate_bps: u32) {
        e.storage().instance().set(&RATE, &rate_bps);
        e.storage().instance().extend_ttl(100_000, 100_000);
    }

    pub fn rate(e: Env) -> u32 {
        e.storage().instance().get(&RATE).unwrap_or(10_000)
    }

    /// Same shape as the `Router` trait of the vault. The vault sends `token_in`
    /// before this call, so the adapter keeps it and pays `token_out` back.
    pub fn swap(e: Env, _token_in: Address, token_out: Address, amount_in: i128, to: Address) -> i128 {
        let rate: u32 = e.storage().instance().get(&RATE).unwrap_or(10_000);
        let amount_out = amount_in * rate as i128 / 10_000;
        token::Client::new(&e, &token_out).transfer(&e.current_contract_address(), &to, &amount_out);
        amount_out
    }
}
