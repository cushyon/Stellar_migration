use soroban_sdk::{token, Address, Env, Vec};

use crate::errors::VaultError;
use crate::storage;

/// Execute a strategy trade with 5 on-chain safety checks.
///
/// The router call is a placeholder — real DEX integration (Soroswap/Phoenix)
/// requires their specific contract interface. Here we simulate a swap by
/// transferring `amount_in` of `token_in` to the router and expecting the
/// router to send back `token_out` to this contract.
pub fn execute(
    e: &Env,
    operator: Address,
    router: Address,
    token_in: Address,
    token_out: Address,
    amount_in: i128,
    min_amount_out: i128,
    _path: Vec<Address>,
) -> Result<(), VaultError> {
    // -----------------------------------------------------------------------
    // 1. Access control
    // -----------------------------------------------------------------------
    operator.require_auth();
    let stored_operator = storage::get_operator(e);
    if operator != stored_operator {
        return Err(VaultError::UnauthorizedOperator);
    }

    // -----------------------------------------------------------------------
    // 2. Token allowlist
    // -----------------------------------------------------------------------
    let config = storage::get_config(e);
    let allowed = &config.allowed_tokens;
    if !allowed.contains(&token_in) || !allowed.contains(&token_out) {
        return Err(VaultError::TokenNotAllowed);
    }

    // -----------------------------------------------------------------------
    // 3. Trade size
    // -----------------------------------------------------------------------
    if amount_in > config.max_trade_size {
        return Err(VaultError::TradeSizeExceeded);
    }

    // -----------------------------------------------------------------------
    // 4. Cooldown
    // -----------------------------------------------------------------------
    let last_trade = storage::get_last_trade_time(e);
    let current_time = e.ledger().timestamp();
    if current_time < last_trade + config.cooldown_period {
        return Err(VaultError::CooldownNotElapsed);
    }

    // -----------------------------------------------------------------------
    // 5. Execute swap + slippage check
    // -----------------------------------------------------------------------
    let contract = e.current_contract_address();

    // Record balance of token_out before swap
    let balance_before = token::Client::new(e, &token_out).balance(&contract);

    // Send token_in to router (the router is expected to send token_out back)
    token::Client::new(e, &token_in).transfer(&contract, &router, &amount_in);

    // Check balance of token_out after swap
    let balance_after = token::Client::new(e, &token_out).balance(&contract);

    if balance_after - balance_before < min_amount_out {
        return Err(VaultError::SlippageExceeded);
    }

    // Update last trade time
    storage::set_last_trade_time(e, current_time);

    Ok(())
}
