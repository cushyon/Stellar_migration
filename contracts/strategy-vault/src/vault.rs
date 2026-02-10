use soroban_sdk::{token, Address, Env};

use crate::errors::VaultError;
use crate::storage;

/// Virtual offset to prevent inflation attacks on empty vaults.
/// With offset = 1, the first depositor cannot manipulate share price
/// by front-running with a tiny deposit + direct transfer.
const VIRTUAL_OFFSET: i128 = 1;

// ---------------------------------------------------------------------------
// Share math — all functions use the virtual offset
// ---------------------------------------------------------------------------

/// Convert assets → shares, rounding DOWN (used for deposit).
pub fn assets_to_shares(total_assets: i128, total_supply: i128, assets: i128) -> i128 {
    let adjusted_supply = total_supply + VIRTUAL_OFFSET;
    let adjusted_assets = total_assets + VIRTUAL_OFFSET;
    // shares = assets * adjusted_supply / adjusted_assets  (round down)
    assets
        .checked_mul(adjusted_supply)
        .unwrap_or(i128::MAX)
        / adjusted_assets
}

/// Convert shares → assets, rounding DOWN (used for redeem).
pub fn shares_to_assets(total_assets: i128, total_supply: i128, shares: i128) -> i128 {
    let adjusted_supply = total_supply + VIRTUAL_OFFSET;
    let adjusted_assets = total_assets + VIRTUAL_OFFSET;
    // assets = shares * adjusted_assets / adjusted_supply  (round down)
    shares
        .checked_mul(adjusted_assets)
        .unwrap_or(i128::MAX)
        / adjusted_supply
}

/// Convert assets → shares, rounding UP (used for withdraw — user burns more shares).
pub fn assets_to_shares_round_up(total_assets: i128, total_supply: i128, assets: i128) -> i128 {
    let adjusted_supply = total_supply + VIRTUAL_OFFSET;
    let adjusted_assets = total_assets + VIRTUAL_OFFSET;
    // ceil(assets * adjusted_supply / adjusted_assets)
    let numerator = assets
        .checked_mul(adjusted_supply)
        .unwrap_or(i128::MAX);
    (numerator + adjusted_assets - 1) / adjusted_assets
}

/// Convert shares → assets, rounding UP (used for mint — user pays more assets).
pub fn shares_to_assets_round_up(total_assets: i128, total_supply: i128, shares: i128) -> i128 {
    let adjusted_supply = total_supply + VIRTUAL_OFFSET;
    let adjusted_assets = total_assets + VIRTUAL_OFFSET;
    // ceil(shares * adjusted_assets / adjusted_supply)
    let numerator = shares
        .checked_mul(adjusted_assets)
        .unwrap_or(i128::MAX);
    (numerator + adjusted_supply - 1) / adjusted_supply
}

// ---------------------------------------------------------------------------
// Real total assets — reads actual token balance (User Exit Guarantee)
// ---------------------------------------------------------------------------

/// Returns the real token balance held by this contract.
/// This ensures `withdraw` is always callable and never depends on
/// any bookkeeping that the strategy could corrupt.
pub fn total_assets(e: &Env) -> i128 {
    let asset = storage::get_asset(e);
    let contract = e.current_contract_address();
    token::Client::new(e, &asset).balance(&contract)
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
