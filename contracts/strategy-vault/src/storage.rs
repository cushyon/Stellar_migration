use soroban_sdk::{contracttype, Address, Env, Map, String, Symbol, Vec};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    // Instance storage (shared TTL)
    Admin,
    Asset,
    Operator,
    Guardian,
    Config,
    TotalShares,
    LastTradeTime,
    Nonce,
    Name,
    Symbol,
    Decimals,

    // Persistent storage (per-address TTL)
    Balance(Address),
    Allowance(Address, Address), // (owner, spender)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct StrategyConfig {
    /// Max `amount_in` per strategy trade, in base units.
    pub max_trade_size: i128,
    /// Minimum seconds between strategy trades.
    pub cooldown_period: u64,
    /// Swap allowlist — both `token_in` and `token_out` must be present.
    pub allowed_tokens: Vec<Address>,

    // --- Floor (Decision 3) -----------------------------------------------
    /// Minimum base-asset allocation, in bps of NAV (0..=10_000). A strategy
    /// trade that would push the base allocation below this reverts.
    /// PARAM: set with Wajih — do not default.
    pub floor_bps: u32,

    // --- Oracle / circuit breaker (Decision 4) ----------------------------
    /// Reflector (SEP-40) oracle contract id, used for NAV pricing and the
    /// `min_amount_out` / floor checks. The vault never accepts an
    /// executor-supplied price.
    pub reflector_id: Address,
    /// Maps each token address (base + risky) to its Reflector ticker symbol.
    /// Reflector's CEX/DEX feed is keyed by symbol (e.g. "XLM", "USDC"), so the
    /// vault needs this to price the tokens it holds by address.
    pub asset_symbols: Map<Address, Symbol>,
    /// Max |lastprice − twap| / twap before execution halts, in bps.
    /// PARAM: set with Wajih — do not default.
    pub deviation_bps: u32,
    /// Max price age (seconds) before a quote is rejected as stale.
    /// PARAM: set with Wajih — do not default.
    pub staleness: u64,

    // --- Inflation protection (Decision 2) --------------------------------
    /// Virtual-share offset exponent: the share-supply term in the conversion
    /// math is `total_supply + 10^decimals_offset` (the asset term is `+1`),
    /// per OZ ERC-4626. Hardening over the weakest setting (0).
    /// PARAM: set with Wajih — do not default.
    pub decimals_offset: u32,

    // --- Fee scaffolding (Decision 6) -------------------------------------
    // INERT in Tranche 1: stored and documented as a deliberate zero-fee MVP,
    // but never applied to any deposit/withdraw/strategy math. Active fee
    // accrual (management + performance) lands in Tranche 3 (D9). Surfaced
    // here so the storage layout is forward-compatible and "zero fees" is an
    // explicit, on-chain choice rather than a silent omission.
    /// Management fee, bps/year. Reserved; must be 0 for Tranche 1.
    pub mgmt_fee_bps: u32,
    /// Performance fee, bps of profit. Reserved; must be 0 for Tranche 1.
    pub perf_fee_bps: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct AllowanceData {
    pub amount: i128,
    pub expiration_ledger: u32,
}

// ---------------------------------------------------------------------------
// TTL constants (in ledgers, ~5 s each on mainnet)
// ---------------------------------------------------------------------------

const INSTANCE_BUMP: u32 = 7 * 24 * 60 * 12;       // ~7 days
const INSTANCE_LIFETIME: u32 = INSTANCE_BUMP - 1;
const PERSISTENT_BUMP: u32 = 30 * 24 * 60 * 12;     // ~30 days
const PERSISTENT_LIFETIME: u32 = PERSISTENT_BUMP - 1;

// ---------------------------------------------------------------------------
// TTL helpers
// ---------------------------------------------------------------------------

pub fn bump_instance(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME, INSTANCE_BUMP);
}

pub fn bump_persistent(e: &Env, key: &DataKey) {
    e.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_LIFETIME, PERSISTENT_BUMP);
}

// ---------------------------------------------------------------------------
// Instance storage helpers
// ---------------------------------------------------------------------------

pub fn get_admin(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Admin).unwrap()
}

pub fn set_admin(e: &Env, admin: &Address) {
    e.storage().instance().set(&DataKey::Admin, admin);
}

pub fn get_asset(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Asset).unwrap()
}

pub fn set_asset(e: &Env, asset: &Address) {
    e.storage().instance().set(&DataKey::Asset, asset);
}

pub fn get_operator(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Operator).unwrap()
}

pub fn set_operator(e: &Env, operator: &Address) {
    e.storage().instance().set(&DataKey::Operator, operator);
}

pub fn get_guardian(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Guardian).unwrap()
}

pub fn set_guardian(e: &Env, guardian: &Address) {
    e.storage().instance().set(&DataKey::Guardian, guardian);
}

pub fn get_config(e: &Env) -> StrategyConfig {
    e.storage().instance().get(&DataKey::Config).unwrap()
}

pub fn set_config(e: &Env, config: &StrategyConfig) {
    e.storage().instance().set(&DataKey::Config, config);
}

pub fn get_total_shares(e: &Env) -> i128 {
    e.storage()
        .instance()
        .get(&DataKey::TotalShares)
        .unwrap_or(0)
}

pub fn set_total_shares(e: &Env, total: i128) {
    e.storage().instance().set(&DataKey::TotalShares, &total);
}

pub fn get_last_trade_time(e: &Env) -> u64 {
    e.storage()
        .instance()
        .get(&DataKey::LastTradeTime)
        .unwrap_or(0)
}

pub fn set_last_trade_time(e: &Env, time: u64) {
    e.storage()
        .instance()
        .set(&DataKey::LastTradeTime, &time);
}

/// Strict, monotonic nonce for `execute_strategy` replay protection.
pub fn get_nonce(e: &Env) -> u64 {
    e.storage().instance().get(&DataKey::Nonce).unwrap_or(0)
}

pub fn set_nonce(e: &Env, nonce: u64) {
    e.storage().instance().set(&DataKey::Nonce, &nonce);
}

pub fn get_name(e: &Env) -> String {
    e.storage().instance().get(&DataKey::Name).unwrap()
}

pub fn set_name(e: &Env, name: &String) {
    e.storage().instance().set(&DataKey::Name, name);
}

pub fn get_symbol(e: &Env) -> String {
    e.storage().instance().get(&DataKey::Symbol).unwrap()
}

pub fn set_symbol(e: &Env, symbol: &String) {
    e.storage().instance().set(&DataKey::Symbol, symbol);
}

pub fn get_decimals(e: &Env) -> u32 {
    e.storage().instance().get(&DataKey::Decimals).unwrap()
}

pub fn set_decimals(e: &Env, decimals: u32) {
    e.storage().instance().set(&DataKey::Decimals, &decimals);
}

pub fn is_initialized(e: &Env) -> bool {
    e.storage().instance().has(&DataKey::Admin)
}

// ---------------------------------------------------------------------------
// Persistent storage helpers (balances & allowances)
// ---------------------------------------------------------------------------

pub fn get_balance(e: &Env, addr: &Address) -> i128 {
    let key = DataKey::Balance(addr.clone());
    let balance = e.storage().persistent().get(&key).unwrap_or(0);
    if balance > 0 {
        bump_persistent(e, &key);
    }
    balance
}

pub fn set_balance(e: &Env, addr: &Address, amount: i128) {
    let key = DataKey::Balance(addr.clone());
    e.storage().persistent().set(&key, &amount);
    bump_persistent(e, &key);
}

pub fn get_allowance(e: &Env, owner: &Address, spender: &Address) -> AllowanceData {
    let key = DataKey::Allowance(owner.clone(), spender.clone());
    if let Some(allowance) = e
        .storage()
        .persistent()
        .get::<DataKey, AllowanceData>(&key)
    {
        if allowance.expiration_ledger < e.ledger().sequence() {
            AllowanceData {
                amount: 0,
                expiration_ledger: allowance.expiration_ledger,
            }
        } else {
            bump_persistent(e, &key);
            allowance
        }
    } else {
        AllowanceData {
            amount: 0,
            expiration_ledger: 0,
        }
    }
}

pub fn set_allowance(
    e: &Env,
    owner: &Address,
    spender: &Address,
    amount: i128,
    expiration_ledger: u32,
) {
    let key = DataKey::Allowance(owner.clone(), spender.clone());
    let allowance = AllowanceData {
        amount,
        expiration_ledger,
    };
    e.storage().persistent().set(&key, &allowance);
    bump_persistent(e, &key);
}
