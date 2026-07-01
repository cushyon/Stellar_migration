#![no_std]

mod errors;
mod events;
mod fees;
mod oracle;
mod storage;
mod strategy;
mod vault;

#[cfg(test)]
mod test;

use errors::VaultError;
use soroban_sdk::{contract, contractimpl, Address, Env, String, Vec};
use stellar_contract_utils::pausable;
use storage::StrategyConfig;

// Re-export for tests
pub use errors::VaultError as VaultErr;

#[contract]
pub struct StrategyVaultContract;

/// Authorize an emergency pause/unpause caller: the dedicated guardian or the
/// admin. Caller `require_auth` is asserted by the entrypoint before this check.
fn require_guardian_or_admin(e: &Env, caller: &Address) -> Result<(), VaultError> {
    if *caller == storage::get_guardian(e) || *caller == storage::get_admin(e) {
        Ok(())
    } else {
        Err(VaultError::UnauthorizedGuardian)
    }
}

// ===========================================================================
// Public interface
// ===========================================================================

#[contractimpl]
impl StrategyVaultContract {
    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        e: Env,
        admin: Address,
        asset: Address,
        operator: Address,
        name: String,
        symbol: String,
        decimals: u32,
        config: StrategyConfig,
    ) -> Result<(), VaultError> {
        if storage::is_initialized(&e) {
            return Err(VaultError::AlreadyInitialized);
        }

        storage::set_admin(&e, &admin);
        storage::set_asset(&e, &asset);
        storage::set_operator(&e, &operator);
        // Guardian (emergency pause authority) defaults to admin; admin can
        // delegate it to a dedicated guardian via `set_guardian`.
        storage::set_guardian(&e, &admin);
        // Fees: recipient defaults to admin; accrual starts now; the HWM is
        // seeded to the baseline share price so deposits aren't treated as profit.
        storage::set_fee_recipient(&e, &admin);
        storage::set_last_fee_time(&e, e.ledger().timestamp());
        storage::set_high_water_mark(&e, fees::baseline_share_price(config.decimals_offset));
        storage::set_name(&e, &name);
        storage::set_symbol(&e, &symbol);
        storage::set_decimals(&e, decimals);
        storage::set_config(&e, &config);
        storage::set_total_shares(&e, 0);

        storage::bump_instance(&e);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // SEP-41 Token Interface (vault shares)
    // -----------------------------------------------------------------------

    pub fn balance(e: Env, id: Address) -> i128 {
        storage::bump_instance(&e);
        storage::get_balance(&e, &id)
    }

    pub fn total_supply(e: Env) -> i128 {
        storage::bump_instance(&e);
        storage::get_total_shares(&e)
    }

    pub fn name(e: Env) -> String {
        storage::bump_instance(&e);
        storage::get_name(&e)
    }

    pub fn symbol(e: Env) -> String {
        storage::bump_instance(&e);
        storage::get_symbol(&e)
    }

    pub fn decimals(e: Env) -> u32 {
        storage::bump_instance(&e);
        storage::get_decimals(&e)
    }

    pub fn transfer(e: Env, from: Address, to: Address, amount: i128) -> Result<(), VaultError> {
        storage::bump_instance(&e);
        from.require_auth();

        if amount < 0 {
            return Err(VaultError::InvalidDepositAmount);
        }

        let from_balance = storage::get_balance(&e, &from);
        if from_balance < amount {
            return Err(VaultError::InsufficientBalance);
        }

        storage::set_balance(&e, &from, from_balance - amount);
        let to_balance = storage::get_balance(&e, &to);
        storage::set_balance(&e, &to, to_balance + amount);

        events::transfer(&e, &from, &to, amount);
        Ok(())
    }

    pub fn approve(
        e: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) -> Result<(), VaultError> {
        storage::bump_instance(&e);
        from.require_auth();

        storage::set_allowance(&e, &from, &spender, amount, expiration_ledger);
        events::approve(&e, &from, &spender, amount, expiration_ledger);
        Ok(())
    }

    pub fn allowance(e: Env, from: Address, spender: Address) -> i128 {
        storage::bump_instance(&e);
        storage::get_allowance(&e, &from, &spender).amount
    }

    pub fn transfer_from(
        e: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), VaultError> {
        storage::bump_instance(&e);
        spender.require_auth();

        let allowance_data = storage::get_allowance(&e, &from, &spender);
        if allowance_data.amount < amount {
            return Err(VaultError::InsufficientAllowance);
        }

        let from_balance = storage::get_balance(&e, &from);
        if from_balance < amount {
            return Err(VaultError::InsufficientBalance);
        }

        storage::set_balance(&e, &from, from_balance - amount);
        let to_balance = storage::get_balance(&e, &to);
        storage::set_balance(&e, &to, to_balance + amount);

        storage::set_allowance(
            &e,
            &from,
            &spender,
            allowance_data.amount - amount,
            allowance_data.expiration_ledger,
        );

        events::transfer(&e, &from, &to, amount);
        Ok(())
    }

    pub fn burn(e: Env, from: Address, amount: i128) -> Result<(), VaultError> {
        storage::bump_instance(&e);
        from.require_auth();
        vault::burn_shares(&e, &from, amount)?;
        events::burn(&e, &from, amount);
        Ok(())
    }

    pub fn burn_from(
        e: Env,
        spender: Address,
        from: Address,
        amount: i128,
    ) -> Result<(), VaultError> {
        storage::bump_instance(&e);
        spender.require_auth();

        let allowance_data = storage::get_allowance(&e, &from, &spender);
        if allowance_data.amount < amount {
            return Err(VaultError::InsufficientAllowance);
        }

        vault::burn_shares(&e, &from, amount)?;

        storage::set_allowance(
            &e,
            &from,
            &spender,
            allowance_data.amount - amount,
            allowance_data.expiration_ledger,
        );

        events::burn(&e, &from, amount);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // SEP-56 Vault Interface
    // -----------------------------------------------------------------------

    /// Returns the underlying asset address.
    pub fn asset(e: Env) -> Address {
        storage::bump_instance(&e);
        storage::get_asset(&e)
    }

    /// Returns total assets held by the vault (real token balance).
    pub fn total_assets(e: Env) -> i128 {
        storage::bump_instance(&e);
        vault::total_assets(&e)
    }

    /// Convert assets to shares (round down).
    pub fn convert_to_shares(e: Env, assets: i128) -> i128 {
        storage::bump_instance(&e);
        let ta = vault::total_assets(&e);
        let ts = storage::get_total_shares(&e);
        vault::assets_to_shares(&e, ta, ts, assets)
    }

    /// Convert shares to assets (round down).
    pub fn convert_to_assets(e: Env, shares: i128) -> i128 {
        storage::bump_instance(&e);
        let ta = vault::total_assets(&e);
        let ts = storage::get_total_shares(&e);
        vault::shares_to_assets(&e, ta, ts, shares)
    }

    pub fn max_deposit(_e: Env, _receiver: Address) -> i128 {
        i128::MAX
    }

    pub fn max_mint(_e: Env, _receiver: Address) -> i128 {
        i128::MAX
    }

    pub fn max_withdraw(e: Env, owner: Address) -> i128 {
        storage::bump_instance(&e);
        let ta = vault::total_assets(&e);
        let ts = storage::get_total_shares(&e);
        let shares = storage::get_balance(&e, &owner);
        vault::shares_to_assets(&e, ta, ts, shares)
    }

    pub fn max_redeem(e: Env, owner: Address) -> i128 {
        storage::bump_instance(&e);
        storage::get_balance(&e, &owner)
    }

    /// Preview how many shares a deposit of `assets` would yield (round down).
    pub fn preview_deposit(e: Env, assets: i128) -> i128 {
        storage::bump_instance(&e);
        let ta = vault::total_assets(&e);
        let ts = storage::get_total_shares(&e);
        vault::assets_to_shares(&e, ta, ts, assets)
    }

    /// Preview how many shares are needed to withdraw `assets` (round up).
    pub fn preview_withdraw(e: Env, assets: i128) -> i128 {
        storage::bump_instance(&e);
        let ta = vault::total_assets(&e);
        let ts = storage::get_total_shares(&e);
        vault::assets_to_shares_round_up(&e, ta, ts, assets)
    }

    /// Preview how many assets redeeming `shares` would yield (round down).
    pub fn preview_redeem(e: Env, shares: i128) -> i128 {
        storage::bump_instance(&e);
        let ta = vault::total_assets(&e);
        let ts = storage::get_total_shares(&e);
        vault::shares_to_assets(&e, ta, ts, shares)
    }

    /// Preview how many assets are needed to mint `shares` (round up).
    pub fn preview_mint(e: Env, shares: i128) -> i128 {
        storage::bump_instance(&e);
        let ta = vault::total_assets(&e);
        let ts = storage::get_total_shares(&e);
        vault::shares_to_assets_round_up(&e, ta, ts, shares)
    }

    /// Deposit `assets` of the underlying token, mint shares to `receiver`.
    pub fn deposit(
        e: Env,
        from: Address,
        assets: i128,
        receiver: Address,
    ) -> Result<i128, VaultError> {
        storage::bump_instance(&e);
        pausable::when_not_paused(&e);
        from.require_auth();

        if assets <= 0 {
            return Err(VaultError::InvalidDepositAmount);
        }

        let ta = vault::total_assets(&e);
        let ts = storage::get_total_shares(&e);
        let shares = vault::assets_to_shares(&e, ta, ts, assets);

        if shares <= 0 {
            return Err(VaultError::InvalidDepositAmount);
        }

        vault::transfer_asset_in(&e, &from, assets);
        vault::mint_shares(&e, &receiver, shares)?;

        events::deposit(&e, &from, &receiver, assets, shares);
        Ok(shares)
    }

    /// Withdraw exactly `assets` of underlying token, burning shares from `owner`.
    /// Anyone can call this — User Exit Guarantee.
    pub fn withdraw(
        e: Env,
        owner: Address,
        assets: i128,
        receiver: Address,
    ) -> Result<i128, VaultError> {
        storage::bump_instance(&e);
        owner.require_auth();

        if assets <= 0 {
            return Err(VaultError::InvalidWithdrawAmount);
        }

        let ta = vault::total_assets(&e);
        let ts = storage::get_total_shares(&e);
        let shares_needed = vault::assets_to_shares_round_up(&e, ta, ts, assets);

        vault::burn_shares(&e, &owner, shares_needed)?;
        vault::transfer_asset_out(&e, &receiver, assets);

        events::withdraw(&e, &owner, &receiver, assets, shares_needed);
        Ok(shares_needed)
    }

    /// Redeem exactly `shares`, sending the corresponding assets to `receiver`.
    pub fn redeem(
        e: Env,
        owner: Address,
        shares: i128,
        receiver: Address,
    ) -> Result<i128, VaultError> {
        storage::bump_instance(&e);
        owner.require_auth();

        if shares <= 0 {
            return Err(VaultError::InvalidRedeemAmount);
        }

        let ta = vault::total_assets(&e);
        let ts = storage::get_total_shares(&e);
        let assets = vault::shares_to_assets(&e, ta, ts, shares);

        if assets <= 0 {
            return Err(VaultError::InvalidRedeemAmount);
        }

        vault::burn_shares(&e, &owner, shares)?;
        vault::transfer_asset_out(&e, &receiver, assets);

        events::withdraw(&e, &owner, &receiver, assets, shares);
        Ok(assets)
    }

    /// Mint exactly `shares` to `receiver`, pulling the required assets from `from`.
    pub fn mint(
        e: Env,
        from: Address,
        shares: i128,
        receiver: Address,
    ) -> Result<i128, VaultError> {
        storage::bump_instance(&e);
        pausable::when_not_paused(&e);
        from.require_auth();

        if shares <= 0 {
            return Err(VaultError::InvalidMintAmount);
        }

        let ta = vault::total_assets(&e);
        let ts = storage::get_total_shares(&e);
        let assets_needed = vault::shares_to_assets_round_up(&e, ta, ts, shares);

        if assets_needed <= 0 {
            return Err(VaultError::InvalidMintAmount);
        }

        vault::transfer_asset_in(&e, &from, assets_needed);
        vault::mint_shares(&e, &receiver, shares)?;

        events::deposit(&e, &from, &receiver, assets_needed, shares);
        Ok(assets_needed)
    }

    // -----------------------------------------------------------------------
    // Strategy execution
    // -----------------------------------------------------------------------

    /// Execute a strategy trade. `nonce` must equal the vault's current nonce
    /// (replay protection); `deadline` is a ledger timestamp past which the
    /// trade is rejected. Frozen signature — the offchain orchestrator builds
    /// transactions against it.
    #[allow(clippy::too_many_arguments)]
    pub fn execute_strategy(
        e: Env,
        operator: Address,
        router: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
        nonce: u64,
        deadline: u64,
        path: Vec<Address>,
    ) -> Result<(), VaultError> {
        storage::bump_instance(&e);
        pausable::when_not_paused(&e);
        strategy::execute(
            &e,
            operator,
            router,
            token_in,
            token_out,
            amount_in,
            min_amount_out,
            nonce,
            deadline,
            path,
        )
    }

    /// Current strategy nonce (next expected value for `execute_strategy`).
    pub fn get_nonce(e: Env) -> u64 {
        storage::bump_instance(&e);
        storage::get_nonce(&e)
    }

    // -----------------------------------------------------------------------
    // Emergency pause (OZ Pausable) + guardian role
    // -----------------------------------------------------------------------

    /// Guardian (or admin) halts deposits/mints/strategy. Withdraw & redeem
    /// stay callable — the User Exit Guarantee survives a pause.
    pub fn pause(e: Env, caller: Address) -> Result<(), VaultError> {
        storage::bump_instance(&e);
        caller.require_auth();
        require_guardian_or_admin(&e, &caller)?;
        pausable::pause(&e); // emits `paused`; reverts (#1000) if already paused
        Ok(())
    }

    /// Guardian (or admin) resumes normal operation.
    pub fn unpause(e: Env, caller: Address) -> Result<(), VaultError> {
        storage::bump_instance(&e);
        caller.require_auth();
        require_guardian_or_admin(&e, &caller)?;
        pausable::unpause(&e); // emits `unpaused`; reverts (#1001) if not paused
        Ok(())
    }

    pub fn paused(e: Env) -> bool {
        storage::bump_instance(&e);
        pausable::paused(&e)
    }

    /// Admin delegates the pause authority to a dedicated guardian address.
    pub fn set_guardian(e: Env, new_guardian: Address) -> Result<(), VaultError> {
        storage::bump_instance(&e);
        let admin = storage::get_admin(&e);
        admin.require_auth();
        storage::set_guardian(&e, &new_guardian);
        Ok(())
    }

    pub fn get_guardian(e: Env) -> Address {
        storage::bump_instance(&e);
        storage::get_guardian(&e)
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    pub fn set_operator(e: Env, new_operator: Address) -> Result<(), VaultError> {
        storage::bump_instance(&e);
        let admin = storage::get_admin(&e);
        admin.require_auth();
        storage::set_operator(&e, &new_operator);
        Ok(())
    }

    pub fn set_config(e: Env, config: StrategyConfig) -> Result<(), VaultError> {
        storage::bump_instance(&e);
        let admin = storage::get_admin(&e);
        admin.require_auth();
        storage::set_config(&e, &config);
        Ok(())
    }

    pub fn set_admin(e: Env, new_admin: Address) -> Result<(), VaultError> {
        storage::bump_instance(&e);
        let admin = storage::get_admin(&e);
        admin.require_auth();
        storage::set_admin(&e, &new_admin);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Query
    // -----------------------------------------------------------------------

    pub fn get_config(e: Env) -> StrategyConfig {
        storage::bump_instance(&e);
        storage::get_config(&e)
    }

    pub fn get_operator(e: Env) -> Address {
        storage::bump_instance(&e);
        storage::get_operator(&e)
    }

    pub fn get_admin(e: Env) -> Address {
        storage::bump_instance(&e);
        storage::get_admin(&e)
    }

    /// Oracle-validated price of `asset` (in base units) via Reflector.
    /// Reverts on a stale / deviating / unavailable price. Read-only view used
    /// by NAV, the frontend, and the indexer.
    pub fn safe_price(e: Env, asset: Address) -> Result<i128, VaultError> {
        storage::bump_instance(&e);
        oracle::get_safe_price(&e, &asset)
    }

    // -----------------------------------------------------------------------
    // Fees (management + performance)
    // -----------------------------------------------------------------------

    /// Accrue management + performance fees and mint the corresponding shares
    /// to the fee recipient. Permissionless. Returns `(mgmt_fee, perf_fee)` in
    /// base-asset units.
    pub fn collect_fees(e: Env) -> Result<(i128, i128), VaultError> {
        storage::bump_instance(&e);
        fees::collect(&e)
    }

    /// Admin sets the address that receives fee shares.
    pub fn set_fee_recipient(e: Env, new_recipient: Address) -> Result<(), VaultError> {
        storage::bump_instance(&e);
        let admin = storage::get_admin(&e);
        admin.require_auth();
        storage::set_fee_recipient(&e, &new_recipient);
        Ok(())
    }

    pub fn get_fee_recipient(e: Env) -> Address {
        storage::bump_instance(&e);
        storage::get_fee_recipient(&e)
    }

    /// Current performance-fee high-water mark (scaled share price).
    pub fn get_high_water_mark(e: Env) -> i128 {
        storage::bump_instance(&e);
        storage::get_high_water_mark(&e)
    }
}
