//! Reflector (SEP-40) oracle integration + onchain price-safety checks.
//!
//! doc-checked (2026-06-30, against the live testnet contract via
//! `stellar contract info interface`): Reflector's "External CEX & DEX" feed
//! (`CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` on testnet)
//! exposes `lastprice(Asset) -> Option<PriceData>` and
//! `prices(Asset, u32) -> Option<Vec<PriceData>>`. Its base is `USD`, prices
//! carry 14 decimals, and assets are keyed by ticker `Asset::Other(Symbol)`
//! (e.g. "XLM", "USDC"). There is NO `twap` / `x_last_price` — the deviation
//! reference is the mean of recent `prices`, and cross-rates are computed
//! manually. Confirm the contract id at deployment; it lives in
//! `StrategyConfig.reflector_id`, never hardcoded.
//!
//! Design (Decision 4, YieldBlox-informed): Reflector is the *primary* price
//! source. The vault NEVER accepts an executor-supplied price.

use soroban_sdk::{contractclient, contracttype, Address, Env, Vec};

use crate::errors::VaultError;
use crate::storage;

/// Decimal scale of Reflector prices (14 dp) and of the cross-rate this module
/// returns. NAV values a risky leg as `risky_balance * get_safe_price / PRICE_SCALE`.
pub const PRICE_SCALE: i128 = 100_000_000_000_000; // 10^14

/// Reflector asset identifier.
#[contracttype]
#[derive(Clone)]
pub enum Asset {
    Stellar(Address),
    Other(soroban_sdk::Symbol),
}

/// Reflector price quote (USD, 14 dp).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

/// Minimal Reflector (SEP-40) client surface used by the vault.
/// The trait only feeds the `#[contractclient]` macro (which generates
/// `ReflectorClient`); it is never implemented or called directly.
#[allow(dead_code)]
#[contractclient(name = "ReflectorClient")]
pub trait ReflectorOracle {
    fn lastprice(e: Env, asset: Asset) -> Option<PriceData>;
    fn prices(e: Env, asset: Asset, records: u32) -> Option<Vec<PriceData>>;
}

/// Number of recent records to average for the deviation reference.
/// PARAM: set with Wajih — do not default.
const DEVIATION_RECORDS: u32 = 6;

/// Validated price of one `asset` unit denominated in the BASE asset, scaled by
/// [`PRICE_SCALE`]. base→base is `PRICE_SCALE` (1.0).
///
/// Reflector quotes in USD, so the base-unit price is the cross-rate
/// `price_asset_usd / price_base_usd` (USD cancels). Both legs are
/// staleness-checked; the asset leg is also deviation-checked (`lastprice` vs
/// the mean of recent `prices`). Assumes base and asset share token decimals
/// (true for the XLM/USDC SACs); a cross-decimal adjustment is a documented
/// follow-up. PARAM: confirm with Wajih.
///
/// Reverts on [`VaultError::PriceUnavailable`] (no quote / unmapped symbol /
/// ≤0), [`VaultError::OracleStale`], or [`VaultError::OracleDeviation`]. The
/// halt is a revert (atomic — a bad oracle can never produce a trade); it emits
/// no event because Soroban rolls events back on revert.
pub fn get_safe_price(e: &Env, asset: &Address) -> Result<i128, VaultError> {
    let base = storage::get_asset(e);
    if *asset == base {
        return Ok(PRICE_SCALE);
    }

    let cfg = storage::get_config(e);
    let client = ReflectorClient::new(e, &cfg.reflector_id);
    let now = e.ledger().timestamp();

    let asset_sym = cfg
        .asset_symbols
        .get(asset.clone())
        .ok_or(VaultError::PriceUnavailable)?;
    let base_sym = cfg
        .asset_symbols
        .get(base)
        .ok_or(VaultError::PriceUnavailable)?;

    let p_asset = client
        .lastprice(&Asset::Other(asset_sym.clone()))
        .ok_or(VaultError::PriceUnavailable)?;
    if now.saturating_sub(p_asset.timestamp) > cfg.staleness {
        return Err(VaultError::OracleStale);
    }

    let p_base = client
        .lastprice(&Asset::Other(base_sym))
        .ok_or(VaultError::PriceUnavailable)?;
    if now.saturating_sub(p_base.timestamp) > cfg.staleness {
        return Err(VaultError::OracleStale);
    }

    if p_asset.price <= 0 || p_base.price <= 0 {
        return Err(VaultError::PriceUnavailable);
    }

    // Deviation circuit breaker on the asset leg.
    check_deviation(&client, &Asset::Other(asset_sym), p_asset.price, cfg.deviation_bps)?;

    // Cross-rate: asset-in-base, scaled. USD cancels.
    let cross = p_asset.price.checked_mul(PRICE_SCALE).unwrap_or(i128::MAX) / p_base.price;
    if cross <= 0 {
        return Err(VaultError::PriceUnavailable);
    }
    Ok(cross)
}

/// Reject if `lastprice` deviates from the mean of recent `prices` by more than
/// `deviation_bps`. If the feed returns no history, the breaker is skipped
/// (staleness still applies).
fn check_deviation(
    client: &ReflectorClient,
    asset: &Asset,
    lastprice: i128,
    deviation_bps: u32,
) -> Result<(), VaultError> {
    let Some(history) = client.prices(asset, &DEVIATION_RECORDS) else {
        return Ok(());
    };
    let n = history.len();
    if n == 0 {
        return Ok(());
    }
    let mut sum: i128 = 0;
    for pd in history.iter() {
        sum = sum.saturating_add(pd.price);
    }
    let mean = sum / n as i128;
    if mean <= 0 {
        return Ok(());
    }
    let diff = (lastprice - mean).abs();
    let lhs = diff.checked_mul(10_000).unwrap_or(i128::MAX);
    let rhs = mean.checked_mul(deviation_bps as i128).unwrap_or(i128::MAX);
    if lhs > rhs {
        return Err(VaultError::OracleDeviation);
    }
    Ok(())
}
