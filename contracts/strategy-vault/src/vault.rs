use soroban_sdk::{panic_with_error, token, Address, Env};

use crate::errors::VaultError;
use crate::oracle::{self, PRICE_SCALE};
use crate::storage;

/// Virtual offset for the SHARE-SUPPLY term: `10^decimals_offset` (from
/// config). The ASSET term uses a constant `+1`. Together (per OZ ERC-4626)
/// this resists first-depositor inflation/donation attacks; a larger
/// `decimals_offset` gives the victim more share precision so their deposit
/// cannot round to zero after a donation. `decimals_offset` is a deliberate
/// security parameter — see `StrategyConfig`. PARAM: set with Wajih.
fn supply_offset(e: &Env) -> i128 {
    let offset = storage::get_config(e).decimals_offset;
    10_i128.checked_pow(offset).unwrap_or(i128::MAX)
}

// ---------------------------------------------------------------------------
// Share math — all functions funnel through the virtual offset.
// `total_assets` is the multi-asset NAV (base + oracle-valued risky legs),
// so share price reflects the whole portfolio.
// ---------------------------------------------------------------------------

/// Convert assets → shares, rounding DOWN (used for deposit).
pub fn assets_to_shares(e: &Env, total_assets: i128, total_supply: i128, assets: i128) -> i128 {
    let adjusted_supply = total_supply + supply_offset(e);
    let adjusted_assets = total_assets + 1;
    // shares = assets * adjusted_supply / adjusted_assets  (round down)
    assets.checked_mul(adjusted_supply).unwrap_or(i128::MAX) / adjusted_assets
}

/// Convert shares → assets, rounding DOWN (used for redeem).
pub fn shares_to_assets(e: &Env, total_assets: i128, total_supply: i128, shares: i128) -> i128 {
    let adjusted_supply = total_supply + supply_offset(e);
    let adjusted_assets = total_assets + 1;
    // assets = shares * adjusted_assets / adjusted_supply  (round down)
    shares.checked_mul(adjusted_assets).unwrap_or(i128::MAX) / adjusted_supply
}

/// Convert assets → shares, rounding UP (used for withdraw — user burns more shares).
pub fn assets_to_shares_round_up(e: &Env, total_assets: i128, total_supply: i128, assets: i128) -> i128 {
    let adjusted_supply = total_supply + supply_offset(e);
    let adjusted_assets = total_assets + 1;
    // ceil(assets * adjusted_supply / adjusted_assets)
    let numerator = assets.checked_mul(adjusted_supply).unwrap_or(i128::MAX);
    (numerator + adjusted_assets - 1) / adjusted_assets
}

/// Convert shares → assets, rounding UP (used for mint — user pays more assets).
pub fn shares_to_assets_round_up(e: &Env, total_assets: i128, total_supply: i128, shares: i128) -> i128 {
    let adjusted_supply = total_supply + supply_offset(e);
    let adjusted_assets = total_assets + 1;
    // ceil(shares * adjusted_assets / adjusted_supply)
    let numerator = shares.checked_mul(adjusted_assets).unwrap_or(i128::MAX);
    (numerator + adjusted_supply - 1) / adjusted_supply
}

// ---------------------------------------------------------------------------
// Real total assets — reads actual token balance (User Exit Guarantee)
// ---------------------------------------------------------------------------

/// Multi-asset NAV in base units: `base_balance + Σ(risky_balanceᵢ × priceᵢ)`,
/// where each non-base allowlisted token the vault holds is valued via the
/// oracle. This is the single chokepoint every conversion/preview funnels
/// through, so share price reflects the whole portfolio (Decision 1).
///
/// It is a *live* read of real balances + oracle prices — never a stored
/// bookkeeping number — which keeps the exit guarantee honest: when the vault
/// holds only base (the keeper-maintained buffer / de-risked state), this needs
/// no oracle and `withdraw`/`redeem` always price correctly. When the vault
/// holds risky legs and the oracle is unavailable/stale/deviating, NAV cannot
/// be computed and the call reverts — a documented limitation (Decision 7 /
/// architecture caveat: no continuous guarantee under keeper downtime or
/// market gaps).
pub fn total_assets(e: &Env) -> i128 {
    let base = storage::get_asset(e);
    let contract = e.current_contract_address();
    let mut nav = token::Client::new(e, &base).balance(&contract);

    let cfg = storage::get_config(e);
    for token_addr in cfg.allowed_tokens.iter() {
        if token_addr == base {
            continue;
        }
        let bal = token::Client::new(e, &token_addr).balance(&contract);
        if bal > 0 {
            // The vault never accepts an executor-supplied price; reverts on a
            // stale/deviating/unavailable oracle.
            let price = match oracle::get_safe_price(e, &token_addr) {
                Ok(p) => p,
                Err(err) => panic_with_error!(e, err),
            };
            let value = bal.checked_mul(price).unwrap_or(i128::MAX) / PRICE_SCALE;
            nav = nav.saturating_add(value);
        }
    }
    nav
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

pub fn mint_shares(e: &Env, to: &Address, amount: i128) -> Result<(), VaultError> {
    if amount <= 0 {
        return Err(VaultError::InvalidDepositAmount);
    }
    let balance = storage::get_balance(e, to);
    storage::set_balance(e, to, balance + amount);
    let total = storage::get_total_shares(e);
    storage::set_total_shares(e, total + amount);
    Ok(())
}

pub fn burn_shares(e: &Env, from: &Address, amount: i128) -> Result<(), VaultError> {
    if amount <= 0 {
        return Err(VaultError::InvalidWithdrawAmount);
    }
    let balance = storage::get_balance(e, from);
    if balance < amount {
        return Err(VaultError::InsufficientShares);
    }
    storage::set_balance(e, from, balance - amount);
    let total = storage::get_total_shares(e);
    storage::set_total_shares(e, total - amount);
    Ok(())
}

pub fn transfer_asset_in(e: &Env, from: &Address, amount: i128) {
    let asset = storage::get_asset(e);
    let contract = e.current_contract_address();
    token::Client::new(e, &asset).transfer(from, &contract, &amount);
}

pub fn transfer_asset_out(e: &Env, to: &Address, amount: i128) {
    let asset = storage::get_asset(e);
    let contract = e.current_contract_address();
    token::Client::new(e, &asset).transfer(&contract, to, &amount);
}
