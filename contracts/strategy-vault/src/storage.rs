use soroban_sdk::{contracttype, Address, Env, String, Vec};

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
    Config,
    TotalShares,
    LastTradeTime,
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
    pub max_trade_size: i128,
    pub cooldown_period: u64,
    pub allowed_tokens: Vec<Address>,
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
