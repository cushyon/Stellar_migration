//! Value floor: the protection the product promises, enforced onchain.
//!
//! The vault measures the value of one share in the **safe asset** (for the
//! product: XLM base, USDC safe). An epoch starts at a share value `initial`.
//! The floor is `floor_bps` of that value, and it ratchets: each time the share
//! value makes a new high that clears one more `lockin_bps` step above
//! `initial`, the floor rises by that step. The floor never comes down.
//!
//! A strategy trade must respect two rules after the swap:
//! - a trade that **adds risk** (its `token_out` is not the safe asset) needs the
//!   share value above the floor before the trade, and at or above it after;
//! - a trade that **removes risk** (`token_out` is the safe asset) is always
//!   allowed, so the vault can protect itself even after a gap under the floor.
//!
//! Once the share value is at or under the floor, the strategy has stopped: no
//! trade may add risk again. Withdrawals are never touched by this module.
//!
//! Values are scaled by `PRICE_SCALE`. The safe asset is assumed to share the
//! base decimals (XLM and USDC both use 7). PARAM: `floor_bps` and `lockin_bps`
//! are risk parameters, set per deployment.

use soroban_sdk::{contracttype, Env};

use crate::errors::VaultError;
use crate::oracle::{self, PRICE_SCALE};
use crate::{fees, storage, vault};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EpochState {
    /// Share value in safe units at the start of the epoch, scaled.
    pub initial: i128,
    /// Highest share value seen in this epoch, scaled.
    pub hwm: i128,
    /// Protected share value, scaled. It never decreases inside an epoch.
    pub floor: i128,
    /// False before the admin starts the first epoch.
    pub active: bool,
}

/// Share value in safe-asset units, scaled by `PRICE_SCALE`, from a NAV in base
/// units. With no shares, the value is the baseline that a first deposit gives.
pub fn share_value_from_nav(e: &Env, nav_base: i128) -> Result<i128, VaultError> {
    let cfg = storage::get_config(e);
    let price_safe = oracle::get_safe_price(e, &cfg.safe_asset)?;
    if price_safe <= 0 {
        return Err(VaultError::PriceUnavailable);
    }
    let supply = storage::get_total_shares(e);
    let value_base_scaled = if supply <= 0 {
        fees::baseline_share_price(cfg.decimals_offset)
    } else {
        nav_base.checked_mul(PRICE_SCALE).ok_or(VaultError::MathOverflow)? / supply
    };
    // base -> safe: one base unit is worth PRICE_SCALE / price_safe safe units.
    value_base_scaled
        .checked_mul(PRICE_SCALE)
        .ok_or(VaultError::MathOverflow)
        .map(|v| v / price_safe)
}

/// Live share value in safe units (reads balances and oracle prices).
pub fn share_value_in_safe(e: &Env) -> Result<i128, VaultError> {
    let supply = storage::get_total_shares(e);
    let nav = if supply > 0 { vault::total_assets(e) } else { 0 };
    share_value_from_nav(e, nav)
}

pub fn get_epoch(e: &Env) -> EpochState {
    EpochState {
        initial: storage::get_epoch_initial(e),
        hwm: storage::get_epoch_hwm(e),
        floor: storage::get_epoch_floor(e),
        active: storage::get_epoch_active(e),
    }
}

/// Start an epoch at the current share value. Allowed before the first epoch,
/// and after the strategy has stopped. Refused while an epoch is live, so an
/// admin cannot lower a live floor.
pub fn start(e: &Env) -> Result<EpochState, VaultError> {
    let cfg = storage::get_config(e);
    let value = share_value_in_safe(e)?;
    if value <= 0 {
        return Err(VaultError::PriceUnavailable);
    }
    let current = get_epoch(e);
    if current.active && value > current.floor {
        return Err(VaultError::EpochActive);
    }
    let floor = value
        .checked_mul(cfg.floor_bps as i128)
        .ok_or(VaultError::MathOverflow)?
        / 10_000;
    storage::set_epoch(e, value, value, floor, true);
    Ok(get_epoch(e))
}

/// Raise the high-water mark and the floor when `value` is a new high. The floor
/// moves in whole `lockin_bps` steps and never goes down. Returns the floor.
pub fn ratchet(e: &Env, value: i128) -> Result<i128, VaultError> {
    let mut st = get_epoch(e);
    if !st.active || value <= st.hwm {
        return Ok(st.floor);
    }
    st.hwm = value;
    let cfg = storage::get_config(e);
    if cfg.lockin_bps > 0 && st.initial > 0 {
        let step = st
            .initial
            .checked_mul(cfg.lockin_bps as i128)
            .ok_or(VaultError::MathOverflow)?
            / 10_000;
        if step > 0 {
            let steps = (st.hwm - st.initial) / step;
            let bps = (cfg.floor_bps as i128)
                .checked_add(steps.checked_mul(cfg.lockin_bps as i128).ok_or(VaultError::MathOverflow)?)
                .ok_or(VaultError::MathOverflow)?;
            let new_floor = st.initial.checked_mul(bps).ok_or(VaultError::MathOverflow)? / 10_000;
            if new_floor > st.floor {
                st.floor = new_floor;
            }
        }
    }
    storage::set_epoch(e, st.initial, st.hwm, st.floor, true);
    Ok(st.floor)
}

/// True once the share value is at or under the floor: the strategy has stopped.
pub fn is_stopped(e: &Env) -> Result<bool, VaultError> {
    let st = get_epoch(e);
    if !st.active {
        return Ok(false);
    }
    Ok(share_value_in_safe(e)? <= st.floor)
}

/// Gate for one strategy trade, evaluated after the swap.
pub fn check_trade(
    e: &Env,
    adds_risk: bool,
    value_before: i128,
    value_after: i128,
) -> Result<(), VaultError> {
    if !get_epoch(e).active {
        return Err(VaultError::EpochNotStarted);
    }
    // A new high reached before this trade lifts the floor first.
    let floor = ratchet(e, value_before)?;
    if adds_risk {
        if value_before <= floor {
            return Err(VaultError::StrategyStopped);
        }
        if value_after < floor {
            return Err(VaultError::FloorBreached);
        }
    }
    ratchet(e, value_after)?;
    Ok(())
}
