use soroban_sdk::{contractclient, token, Address, Env, Vec};

use crate::errors::VaultError;
use crate::{events, floor, oracle, storage, vault};

/// Generic DEX router surface the vault swaps through. For Tranche 1 this is a
/// placeholder interface exercised by a mock in tests; real Soroswap/Phoenix
/// adapters land in Tranche 2. The vault sends `amount_in` of `token_in` to the
/// router, then calls `swap`, which delivers `token_out` to `to` and returns
/// the amount delivered.
#[allow(dead_code)]
#[contractclient(name = "RouterClient")]
pub trait Router {
    fn swap(e: Env, token_in: Address, token_out: Address, amount_in: i128, to: Address) -> i128;
}

/// Execute a strategy trade with the full set of onchain safeguards.
///
/// Order (cheap/authorization checks first, then the trade, then post-trade
/// invariants): auth → nonce → deadline → token allowlist → router allowlist →
/// trade-size cap → cooldown → swap → operator slippage floor → oracle
/// slippage cap → value floor (epoch started, stop rule, floor kept, ratchet)
/// → commit (nonce++, cooldown, event).
#[allow(clippy::too_many_arguments)]
pub fn execute(
    e: &Env,
    operator: Address,
    router: Address,
    token_in: Address,
    token_out: Address,
    amount_in: i128,
    min_amount_out: i128,
    nonce: u64,
    deadline: u64,
    _path: Vec<Address>,
) -> Result<(), VaultError> {
    // 1. Access control.
    operator.require_auth();
    if operator != storage::get_operator(e) {
        return Err(VaultError::UnauthorizedOperator);
    }

    // 2. Replay protection - strict, monotonic nonce.
    let expected_nonce = storage::get_nonce(e);
    if nonce != expected_nonce {
        return Err(VaultError::NonceMismatch);
    }

    // 3. Deadline.
    let now = e.ledger().timestamp();
    if now > deadline {
        return Err(VaultError::DeadlineExpired);
    }

    // 4. Token allowlist.
    let config = storage::get_config(e);
    if !config.allowed_tokens.contains(&token_in) || !config.allowed_tokens.contains(&token_out) {
        return Err(VaultError::TokenNotAllowed);
    }

    // 5. Venue allowlist: the router must be a vetted DEX adapter, or a
    //    compromised operator could route through a contract of their own.
    if !config.allowed_routers.contains(&router) {
        return Err(VaultError::RouterNotAllowed);
    }

    // 6. Trade-size cap.
    if amount_in > config.max_trade_size {
        return Err(VaultError::TradeSizeExceeded);
    }

    // 7. Cooldown.
    let last_trade = storage::get_last_trade_time(e);
    if now < last_trade + config.cooldown_period {
        return Err(VaultError::CooldownNotElapsed);
    }

    let contract = e.current_contract_address();
    // NAV is oracle-valued; reverts here if the oracle is stale/deviating, so a
    // bad price can never be used to clear the floor check below.
    let nav_before = vault::total_assets(e);
    let value_before = floor::share_value_from_nav(e, nav_before)?;

    // 8. Swap through the router and measure realized output.
    let balance_out_before = token::Client::new(e, &token_out).balance(&contract);
    token::Client::new(e, &token_in).transfer(&contract, &router, &amount_in);
    let _reported = RouterClient::new(e, &router).swap(&token_in, &token_out, &amount_in, &contract);
    let balance_out_after = token::Client::new(e, &token_out).balance(&contract);
    let amount_out = balance_out_after - balance_out_before;

    // 9. Slippage - realized output must meet the operator's floor.
    if amount_out < min_amount_out {
        return Err(VaultError::SlippageExceeded);
    }

    // 10. Onchain slippage cap: realized output must also clear the
    //     oracle-implied minimum. A hard protocol bound the operator cannot
    //     loosen (a colluding `min_amount_out` of 1 changes nothing here).
    //     expected_out = amount_in * price_in / price_out (both oracle-valued
    //     in base units, PRICE_SCALE cancels).
    let price_in = oracle::get_safe_price(e, &token_in)?;
    let price_out = oracle::get_safe_price(e, &token_out)?;
    let expected_out = amount_in
        .checked_mul(price_in)
        .ok_or(VaultError::MathOverflow)?
        / price_out;
    let cap_bps = config.max_slippage_bps.min(10_000) as i128;
    let min_allowed = expected_out
        .checked_mul(10_000 - cap_bps)
        .ok_or(VaultError::MathOverflow)?
        / 10_000;
    if amount_out < min_allowed {
        return Err(VaultError::SlippageCapExceeded);
    }

    // 11. Value floor. The share value, measured in the safe asset, must stay
    //     at or above the epoch floor after a trade that adds risk, and no trade
    //     may add risk once the strategy has stopped (value at or under the
    //     floor). A trade into the safe asset is always allowed. The floor
    //     ratchets up on a new high and never comes down.
    let nav_after = vault::total_assets(e);
    let value_after = floor::share_value_from_nav(e, nav_after)?;
    let adds_risk = token_out != config.safe_asset;
    floor::check_trade(e, adds_risk, value_before, value_after)?;

    // 12. Commit.
    storage::set_last_trade_time(e, now);
    storage::set_nonce(e, expected_nonce + 1);
    events::strategy(
        e, &operator, nonce, &token_in, &token_out, amount_in, amount_out, nav_before, nav_after,
    );
    Ok(())
}
