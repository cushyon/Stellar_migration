//! Management + performance fee accrual.
//!
//! - **Management fee**: `mgmt_fee_bps` per year of NAV, prorated by the time
//!   elapsed since the last collection.
//! - **Performance fee**: `perf_fee_bps` of the profit realized above a
//!   **high-water mark** (HWM) - the highest scaled share price at which a perf
//!   fee was last taken. New gains above the HWM are charged; the HWM then
//!   ratchets up, so the same gain is never charged twice.
//!
//! Both are paid by **minting shares to the fee recipient** (dilution of
//! existing holders), valued at the current share price. `collect` is
//! permissionless - anyone may trigger it; the fees only ever accrue to the
//! configured recipient.

use soroban_sdk::Env;

use crate::errors::VaultError;
use crate::oracle::PRICE_SCALE;
use crate::{events, storage, vault};

const SECONDS_PER_YEAR: i128 = 31_536_000;

/// Scaled share price = `NAV * PRICE_SCALE / total_supply`.
pub fn share_price(nav: i128, supply: i128) -> i128 {
    if supply <= 0 {
        return 0;
    }
    nav.checked_mul(PRICE_SCALE).unwrap_or(i128::MAX) / supply
}

/// The baseline share price a fair deposit produces (`PRICE_SCALE / 10^offset`),
/// used to seed the HWM at initialization so deposits aren't treated as profit.
pub fn baseline_share_price(decimals_offset: u32) -> i128 {
    let pow = 10_i128.checked_pow(decimals_offset).unwrap_or(i128::MAX);
    PRICE_SCALE / pow
}

/// Accrue management + performance fees and mint the corresponding shares to the
/// fee recipient. Returns `(mgmt_fee, perf_fee)` in base-asset units.
pub fn collect(e: &Env) -> Result<(i128, i128), VaultError> {
    let cfg = storage::get_config(e);
    let nav = vault::total_assets(e);
    let supply = storage::get_total_shares(e);
    let now = e.ledger().timestamp();

    if supply <= 0 || nav <= 0 {
        storage::set_last_fee_time(e, now);
        return Ok((0, 0));
    }

    // Management fee: mgmt_fee_bps/year of NAV, prorated by elapsed seconds.
    let elapsed = now.saturating_sub(storage::get_last_fee_time(e)) as i128;
    let mgmt_fee = nav
        .checked_mul(cfg.mgmt_fee_bps as i128)
        .unwrap_or(i128::MAX)
        .checked_mul(elapsed)
        .unwrap_or(i128::MAX)
        / (10_000 * SECONDS_PER_YEAR);

    // Performance fee: perf_fee_bps of profit above the high-water mark.
    let sp = share_price(nav, supply);
    let hwm = storage::get_high_water_mark(e);
    let mut perf_fee = 0;
    if sp > hwm {
        let profit = (sp - hwm).checked_mul(supply).unwrap_or(i128::MAX) / PRICE_SCALE;
        perf_fee = profit
            .checked_mul(cfg.perf_fee_bps as i128)
            .unwrap_or(i128::MAX)
            / 10_000;
    }

    let total_fee = mgmt_fee + perf_fee;
    if total_fee > 0 && nav > total_fee {
        // Mint shares worth `total_fee` at the current price (dilutes holders).
        let shares_minted = vault::assets_to_shares(e, nav, supply, total_fee);
        if shares_minted > 0 {
            let recipient = storage::get_fee_recipient(e);
            vault::mint_shares(e, &recipient, shares_minted)?;
            events::fees(e, &recipient, mgmt_fee, perf_fee, shares_minted);
        }
    }

    storage::set_last_fee_time(e, now);
    // Ratchet the HWM up to the gross (pre-fee) share price.
    if sp > hwm {
        storage::set_high_water_mark(e, sp);
    }

    Ok((mgmt_fee, perf_fee))
}
