#![cfg(test)]
// Token amounts are written as `<whole>_<7-decimals>` (e.g. 1_000_0000000 =
// 1000.0 at 7 dp); this deliberate grouping trips clippy's digit-grouping lint.
#![allow(clippy::inconsistent_digit_grouping)]

extern crate std;

use crate::oracle::{Asset, PriceData};
use crate::storage::StrategyConfig;
use crate::{events, StrategyVaultContract, StrategyVaultContractClient};
use soroban_sdk::{
    contract, contractimpl, symbol_short, vec,
    testutils::{Address as _, Events as _, Ledger as _},
    token, Address, Env, Event, Map, String, Symbol, Vec,
};
use stellar_contract_utils::pausable;

// ---------------------------------------------------------------------------
// Mock Reflector oracle - matches the SEP-40 surface the vault calls
// (lastprice / twap). `set` configures the returned quote; an unconfigured
// instance returns None (→ PriceUnavailable).
// ---------------------------------------------------------------------------

#[contract]
pub struct MockReflector;

#[contractimpl]
impl MockReflector {
    /// Configure a symbol's lastprice + recent-price mean (deviation reference)
    /// + timestamp.
    pub fn set(e: Env, sym: Symbol, price: i128, hist: i128, ts: u64) {
        let mut lp: Map<Symbol, PriceData> =
            e.storage().instance().get(&symbol_short!("LP")).unwrap_or(Map::new(&e));
        let mut h: Map<Symbol, i128> =
            e.storage().instance().get(&symbol_short!("H")).unwrap_or(Map::new(&e));
        lp.set(sym.clone(), PriceData { price, timestamp: ts });
        h.set(sym, hist);
        e.storage().instance().set(&symbol_short!("LP"), &lp);
        e.storage().instance().set(&symbol_short!("H"), &h);
    }

    pub fn lastprice(e: Env, asset: Asset) -> Option<PriceData> {
        let sym = match asset {
            Asset::Other(s) => s,
            _ => return None,
        };
        let lp: Map<Symbol, PriceData> = e.storage().instance().get(&symbol_short!("LP"))?;
        lp.get(sym)
    }

    pub fn prices(e: Env, asset: Asset, _records: u32) -> Option<Vec<PriceData>> {
        let sym = match asset {
            Asset::Other(s) => s,
            _ => return None,
        };
        let lp: Map<Symbol, PriceData> = e.storage().instance().get(&symbol_short!("LP"))?;
        let h: Map<Symbol, i128> = e.storage().instance().get(&symbol_short!("H"))?;
        let ts = lp.get(sym.clone()).map(|p| p.timestamp).unwrap_or(0);
        let mean = h.get(sym)?;
        Some(vec![
            &e,
            PriceData { price: mean, timestamp: ts },
            PriceData { price: mean, timestamp: ts },
        ])
    }
}

/// Point an already-initialised vault at a mock Reflector, allowlist `risky`,
/// map base→"XLM" / risky→"RSK", and pre-price the base (XLM) at 1.0 USD so a
/// risky USD price equals its base cross-rate directly.
fn point_vault_at_mock(e: &Env, vault_addr: &Address, base: &Address, risky: &Address, mock: &Address) {
    let vault = StrategyVaultContractClient::new(e, vault_addr);
    let mut allowed = Vec::new(e);
    allowed.push_back(base.clone());
    allowed.push_back(risky.clone());
    let mut syms: Map<Address, Symbol> = Map::new(e);
    syms.set(base.clone(), symbol_short!("XLM"));
    syms.set(risky.clone(), symbol_short!("RSK"));
    vault.set_config(&make_config(1_000_000_0000000, 60, allowed, mock.clone(), syms));
    MockReflectorClient::new(e, mock).set(
        &symbol_short!("XLM"),
        &PRICE_SCALE,
        &PRICE_SCALE,
        &e.ledger().timestamp(),
    );
}

// ---------------------------------------------------------------------------
// Mock DEX router for strategy tests - delivers a configured amount of
// `token_out` on swap (pre-funded with `token_out`). `set_out` configures it.
// ---------------------------------------------------------------------------

#[contract]
pub struct MockRouter;

#[contractimpl]
impl MockRouter {
    pub fn set_out(e: Env, amount: i128) {
        e.storage().instance().set(&symbol_short!("out"), &amount);
    }

    pub fn swap(e: Env, _token_in: Address, token_out: Address, _amount_in: i128, to: Address) -> i128 {
        let out: i128 = e.storage().instance().get(&symbol_short!("out")).unwrap_or(0);
        let me = e.current_contract_address();
        token::Client::new(&e, &token_out).transfer(&me, &to, &out);
        out
    }
}

/// Full fixture for strategy execution: base + risky SAC tokens, a mock oracle,
/// a pre-funded mock router, and an initialised vault (allowlisting both
/// tokens). Ledger time is 100_000 so the first trade clears the cooldown.
struct StratFix {
    base: Address,
    risky: Address,
    router: Address,
    oracle: Address,
    vault: Address,
    op: Address,
    user: Address,
}

fn setup_strategy(e: &Env) -> StratFix {
    e.mock_all_auths();
    e.ledger().set_timestamp(100_000);

    let admin = Address::generate(e);
    let op = Address::generate(e);
    let user = Address::generate(e);

    let base = e.register_stellar_asset_contract_v2(admin.clone()).address();
    let base_sac = token::StellarAssetClient::new(e, &base);
    let risky = e.register_stellar_asset_contract_v2(admin.clone()).address();
    let risky_sac = token::StellarAssetClient::new(e, &risky);

    let oracle = e.register(MockReflector, ());
    let router = e.register(MockRouter, ());

    let vault_addr = e.register(StrategyVaultContract, ());
    let vault = StrategyVaultContractClient::new(e, &vault_addr);

    let mut allowed = Vec::new(e);
    allowed.push_back(base.clone());
    allowed.push_back(risky.clone());
    let mut syms: Map<Address, Symbol> = Map::new(e);
    syms.set(base.clone(), symbol_short!("XLM"));
    syms.set(risky.clone(), symbol_short!("RSK"));
    let mut config = make_config(1_000_000_0000000, 60, allowed, oracle.clone(), syms);
    config.allowed_routers.push_back(router.clone());
    vault.initialize(
        &admin,
        &base,
        &op,
        &String::from_str(e, "Vault Share"),
        &String::from_str(e, "vSHARE"),
        &7u32,
        &config,
    );

    // Fund the user, and pre-fund the router with risky so swaps can pay out.
    base_sac.mint(&user, &100_000_0000000);
    risky_sac.mint(&router, &100_000_0000000);

    // Base (XLM) priced at 1.0 USD so a risky USD price equals its base cross-rate.
    MockReflectorClient::new(e, &oracle).set(
        &symbol_short!("XLM"),
        &PRICE_SCALE,
        &PRICE_SCALE,
        &100_000u64,
    );

    StratFix { base, risky, router, oracle, vault: vault_addr, op, user }
}

// ===========================================================================
// Test setup macro - avoids lifetime issues with clients
// ===========================================================================

macro_rules! setup {
    ($e:ident, $token_addr:ident, $sac:ident, $tc:ident,
     $vault_addr:ident, $vault:ident,
     $admin:ident, $op:ident, $user:ident) => {
        let $e = Env::default();
        $e.mock_all_auths();

        #[allow(unused_variables)]
        let $admin = Address::generate(&$e);
        #[allow(unused_variables)]
        let $op = Address::generate(&$e);
        #[allow(unused_variables)]
        let $user = Address::generate(&$e);

        #[allow(unused_variables)]
        let $token_addr = $e.register_stellar_asset_contract_v2($admin.clone()).address();
        #[allow(unused_variables)]
        let $sac = token::StellarAssetClient::new(&$e, &$token_addr);
        #[allow(unused_variables)]
        let $tc = token::Client::new(&$e, &$token_addr);

        #[allow(unused_variables)]
        let $vault_addr: Address = $e.register(StrategyVaultContract, ());
        let $vault = StrategyVaultContractClient::new(&$e, &$vault_addr);

        let mut allowed = Vec::new(&$e);
        allowed.push_back($token_addr.clone());
        let config = make_config(1_000_000_0000000, 60, allowed, Address::generate(&$e), Map::new(&$e));

        $vault.initialize(
            &$admin,
            &$token_addr,
            &$op,
            &String::from_str(&$e, "Vault Share"),
            &String::from_str(&$e, "vSHARE"),
            &7u32,
            &config,
        );

        // Fund user with 10,000 tokens (7 decimals)
        $sac.mint(&$user, &10_000_0000000);
    };
}

// Deliberate test values. Production values are PARAM: set with Wajih.
const TEST_FLOOR_BPS: u32 = 6_000; // 60% base-asset floor (matches the vault narrative)
const TEST_DEVIATION_BPS: u32 = 500; // 5% lastprice-vs-twap halt threshold
const TEST_STALENESS: u64 = 3_600; // 1h max price age
const TEST_DECIMALS_OFFSET: u32 = 3; // virtual-share offset (hardened over 0)
const TEST_MAX_SLIPPAGE_BPS: u32 = 100; // 1% hard onchain cap vs oracle price
const PRICE_SCALE: i128 = 100_000_000_000_000; // 10^14, oracle price decimals

/// Build a `StrategyConfig` for tests. Fee bps default to 0 (Tranche-1 inert).
/// Centralised so new config fields don't require touching every call site.
fn make_config(
    max_trade_size: i128,
    cooldown: u64,
    allowed: Vec<Address>,
    reflector_id: Address,
    asset_symbols: Map<Address, Symbol>,
) -> StrategyConfig {
    StrategyConfig {
        max_trade_size,
        cooldown_period: cooldown,
        allowed_routers: Vec::new(allowed.env()),
        allowed_tokens: allowed,
        max_slippage_bps: TEST_MAX_SLIPPAGE_BPS,
        floor_bps: TEST_FLOOR_BPS,
        reflector_id,
        asset_symbols,
        deviation_bps: TEST_DEVIATION_BPS,
        staleness: TEST_STALENESS,
        decimals_offset: TEST_DECIMALS_OFFSET,
        mgmt_fee_bps: 0,
        perf_fee_bps: 0,
    }
}

/// Config with fees enabled (base-only allowlist, empty symbol map).
fn fee_config(e: &Env, base: &Address, mgmt: u32, perf: u32) -> StrategyConfig {
    let mut allowed = Vec::new(e);
    allowed.push_back(base.clone());
    let mut cfg = make_config(1_000_000_0000000, 60, allowed, Address::generate(e), Map::new(e));
    cfg.mgmt_fee_bps = mgmt;
    cfg.perf_fee_bps = perf;
    cfg
}

// ===========================================================================
// Initialization tests
// ===========================================================================

#[test]
fn test_initialization() {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let operator = Address::generate(&e);
    let token_addr = e.register_stellar_asset_contract_v2(admin.clone()).address();
    let vault_addr: Address = e.register(StrategyVaultContract, ());
    let vault = StrategyVaultContractClient::new(&e, &vault_addr);

    let mut allowed = Vec::new(&e);
    allowed.push_back(token_addr.clone());
    let config = make_config(1_000_000_0000000, 60, allowed, Address::generate(&e), Map::new(&e));

    vault.initialize(
        &admin,
        &token_addr,
        &operator,
        &String::from_str(&e, "Vault Share"),
        &String::from_str(&e, "vSHARE"),
        &7u32,
        &config,
    );

    assert_eq!(vault.name(), String::from_str(&e, "Vault Share"));
    assert_eq!(vault.symbol(), String::from_str(&e, "vSHARE"));
    assert_eq!(vault.decimals(), 7);
    assert_eq!(vault.total_supply(), 0);
    assert_eq!(vault.asset(), token_addr);
    assert_eq!(vault.get_admin(), admin);
    assert_eq!(vault.get_operator(), operator);
}

#[test]
#[should_panic(expected = "Error(Contract, #31)")]
fn test_double_initialization_fails() {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let operator = Address::generate(&e);
    let token_addr = e.register_stellar_asset_contract_v2(admin.clone()).address();
    let vault_addr: Address = e.register(StrategyVaultContract, ());
    let vault = StrategyVaultContractClient::new(&e, &vault_addr);

    let mut allowed = Vec::new(&e);
    allowed.push_back(token_addr.clone());
    let config = make_config(1_000_000_0000000, 60, allowed, Address::generate(&e), Map::new(&e));

    vault.initialize(
        &admin, &token_addr, &operator,
        &String::from_str(&e, "VS"), &String::from_str(&e, "VS"),
        &7u32, &config,
    );

    // Second call must fail with AlreadyInitialized (31)
    vault.initialize(
        &admin, &token_addr, &operator,
        &String::from_str(&e, "VS"), &String::from_str(&e, "VS"),
        &7u32, &config,
    );
}

// ===========================================================================
// Deposit tests
// ===========================================================================

#[test]
fn test_first_deposit() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);

    let shares = vault.deposit(&user, &1_000_0000000i128, &user);
    assert!(shares > 0);
    assert_eq!(vault.balance(&user), shares);
    assert_eq!(vault.total_supply(), shares);
    assert_eq!(vault.total_assets(), 1_000_0000000);
}

#[test]
fn test_second_deposit_proportional() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    let user2 = Address::generate(&e);
    sac.mint(&user2, &10_000_0000000);

    let shares1 = vault.deposit(&user, &1_000_0000000i128, &user);
    let shares2 = vault.deposit(&user2, &1_000_0000000i128, &user2);

    // Due to virtual offset, shares2 might be slightly different but very close
    let diff = (shares1 - shares2).abs();
    assert!(diff <= 1, "shares should be approximately equal");
    assert_eq!(vault.total_assets(), 2_000_0000000);
}

#[test]
fn test_deposit_different_receiver() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    let receiver = Address::generate(&e);

    let shares = vault.deposit(&user, &500_0000000i128, &receiver);
    assert_eq!(vault.balance(&receiver), shares);
    assert_eq!(vault.balance(&user), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn test_deposit_zero_fails() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    vault.deposit(&user, &0i128, &user);
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn test_deposit_negative_fails() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    vault.deposit(&user, &-100i128, &user);
}

// ===========================================================================
// Withdraw tests
// ===========================================================================

#[test]
fn test_withdraw_full() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);

    vault.deposit(&user, &1_000_0000000i128, &user);

    let balance_before = tc.balance(&user);
    let max_w = vault.max_withdraw(&user);
    vault.withdraw(&user, &max_w, &user);

    let balance_after = tc.balance(&user);
    assert_eq!(balance_after - balance_before, max_w);
    assert_eq!(vault.balance(&user), 0);
}

#[test]
fn test_withdraw_partial() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);

    vault.deposit(&user, &1_000_0000000i128, &user);

    let balance_before = tc.balance(&user);
    vault.withdraw(&user, &500_0000000i128, &user);
    let balance_after = tc.balance(&user);

    assert_eq!(balance_after - balance_before, 500_0000000);
    assert!(vault.balance(&user) > 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_withdraw_exceeds_balance_fails() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);

    vault.deposit(&user, &100_0000000i128, &user);
    vault.withdraw(&user, &200_0000000i128, &user);
}

// ===========================================================================
// Redeem tests
// ===========================================================================

#[test]
fn test_redeem_all_shares() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);

    vault.deposit(&user, &1_000_0000000i128, &user);
    let shares = vault.balance(&user);

    let balance_before = tc.balance(&user);
    let assets = vault.redeem(&user, &shares, &user);
    let balance_after = tc.balance(&user);

    assert_eq!(balance_after - balance_before, assets);
    assert_eq!(vault.balance(&user), 0);
    assert_eq!(vault.total_supply(), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #14)")]
fn test_redeem_zero_fails() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    vault.deposit(&user, &1_000_0000000i128, &user);
    vault.redeem(&user, &0i128, &user);
}

// ===========================================================================
// Preview & conversion tests
// ===========================================================================

#[test]
fn test_preview_deposit_matches_deposit() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);

    let amount = 1_000_0000000i128;
    let preview = vault.preview_deposit(&amount);
    let actual = vault.deposit(&user, &amount, &user);
    assert_eq!(preview, actual);
}

#[test]
fn test_preview_withdraw_rounds_up() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);

    vault.deposit(&user, &1_000_0000000i128, &user);

    let assets = 500_0000000i128;
    let preview_w = vault.preview_withdraw(&assets);
    let preview_d = vault.preview_deposit(&assets);

    // preview_withdraw rounds UP so it should be >= preview_deposit
    assert!(preview_w >= preview_d);
}

#[test]
fn test_convert_roundtrip() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);

    vault.deposit(&user, &1_000_0000000i128, &user);

    let assets = 500_0000000i128;
    let shares = vault.convert_to_shares(&assets);
    let back = vault.convert_to_assets(&shares);

    // Rounding down both ways - back should be <= original
    assert!(back <= assets);
    // But very close (within 1 unit)
    assert!(assets - back <= 1);
}

// ===========================================================================
// SEP-41 share token tests
// ===========================================================================

#[test]
fn test_share_transfer() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    let user2 = Address::generate(&e);

    vault.deposit(&user, &1_000_0000000i128, &user);
    let shares = vault.balance(&user);
    let half = shares / 2;

    vault.transfer(&user, &user2, &half);

    assert_eq!(vault.balance(&user), shares - half);
    assert_eq!(vault.balance(&user2), half);
}

#[test]
fn test_approve_and_transfer_from() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    let spender = Address::generate(&e);
    let recipient = Address::generate(&e);

    vault.deposit(&user, &1_000_0000000i128, &user);
    let shares = vault.balance(&user);
    let amount = shares / 4;

    vault.approve(&user, &spender, &amount, &10000u32);
    assert_eq!(vault.allowance(&user, &spender), amount);

    vault.transfer_from(&spender, &user, &recipient, &amount);

    assert_eq!(vault.balance(&recipient), amount);
    assert_eq!(vault.balance(&user), shares - amount);
    assert_eq!(vault.allowance(&user, &spender), 0);
}

// ===========================================================================
// User Exit Guarantee tests
// ===========================================================================

#[test]
fn test_withdraw_always_available() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);

    vault.deposit(&user, &1_000_0000000i128, &user);

    let max_w = vault.max_withdraw(&user);
    assert!(max_w > 0);

    vault.withdraw(&user, &max_w, &user);
    assert_eq!(vault.balance(&user), 0);
}

#[test]
fn test_multiple_users_withdraw_independently() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);

    let user2 = Address::generate(&e);
    sac.mint(&user2, &10_000_0000000);

    vault.deposit(&user, &1_000_0000000i128, &user);
    vault.deposit(&user2, &2_000_0000000i128, &user2);

    // user withdraws
    let max_w1 = vault.max_withdraw(&user);
    vault.withdraw(&user, &max_w1, &user);
    assert_eq!(vault.balance(&user), 0);

    // user2 can still withdraw independently
    let max_w2 = vault.max_withdraw(&user2);
    assert!(max_w2 > 0);
    vault.withdraw(&user2, &max_w2, &user2);
    assert_eq!(vault.balance(&user2), 0);
}

// ===========================================================================
// Strategy negative tests
// ===========================================================================

#[test]
#[should_panic(expected = "Error(Contract, #20)")]
fn test_strategy_unauthorized_caller() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    let router = Address::generate(&e);

    vault.deposit(&user, &1_000_0000000i128, &user);

    // user is not the operator - should fail
    vault.execute_strategy(
        &user, &router, &token_addr, &token_addr,
        &100_0000000i128, &90_0000000i128, &0u64, &200_000u64, &Vec::new(&e),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")]
fn test_strategy_non_whitelisted_token() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    let router = Address::generate(&e);
    let bad_token = Address::generate(&e);

    vault.deposit(&user, &1_000_0000000i128, &user);

    // bad_token is not in allowed_tokens
    vault.execute_strategy(
        &op, &router, &token_addr, &bad_token,
        &100_0000000i128, &90_0000000i128, &0u64, &200_000u64, &Vec::new(&e),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #22)")]
fn test_strategy_trade_size_exceeded() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    let router = Address::generate(&e);

    // Allowlist the router so the trade-size cap is the check under test.
    let mut cfg = vault.get_config();
    cfg.allowed_routers.push_back(router.clone());
    vault.set_config(&cfg);

    vault.deposit(&user, &1_000_0000000i128, &user);

    // Exceed max trade size (default 1,000,000 tokens)
    vault.execute_strategy(
        &op, &router, &token_addr, &token_addr,
        &2_000_000_0000000i128, &1_000_000_0000000i128, &0u64, &200_000u64, &Vec::new(&e),
    );
}

// ===========================================================================
// Inflation attack resistance
// ===========================================================================

#[test]
fn test_virtual_offset_prevents_inflation_attack() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);

    // Attacker deposits a tiny amount
    let attacker = Address::generate(&e);
    sac.mint(&attacker, &10_000_0000000);

    let attacker_shares = vault.deposit(&attacker, &1i128, &attacker);
    assert!(attacker_shares > 0);

    // Even if attacker could donate directly to the vault (inflating total_assets),
    // the virtual offset ensures the victim still gets meaningful shares.
    // We simulate by having attacker donate to vault address directly.
    tc.transfer(&attacker, &vault_addr, &1_000_0000000i128);

    // Victim deposits - should still get a non-trivial share amount
    let victim = Address::generate(&e);
    sac.mint(&victim, &10_000_0000000);
    let victim_shares = vault.deposit(&victim, &1_000_0000000i128, &victim);
    assert!(victim_shares > 0, "victim must receive shares despite donation attack");
}

// ===========================================================================
// Admin tests
// ===========================================================================

#[test]
fn test_set_operator() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, _user);
    let new_op = Address::generate(&e);

    vault.set_operator(&new_op);
    assert_eq!(vault.get_operator(), new_op);
}

#[test]
fn test_update_config() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, _user);

    let mut allowed = Vec::new(&e);
    allowed.push_back(token_addr.clone());
    let new_config = make_config(500_0000000, 120, allowed, Address::generate(&e), Map::new(&e));

    vault.set_config(&new_config);
    let stored = vault.get_config();
    assert_eq!(stored.max_trade_size, 500_0000000);
    assert_eq!(stored.cooldown_period, 120);
    assert_eq!(stored.mgmt_fee_bps, 0);
    assert_eq!(stored.perf_fee_bps, 0);
}

#[test]
fn test_set_admin() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, _user);
    let new_admin = Address::generate(&e);

    vault.set_admin(&new_admin);
    assert_eq!(vault.get_admin(), new_admin);
}

// ===========================================================================
// Mint tests
// ===========================================================================

#[test]
fn test_mint_shares() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);

    let balance_before = tc.balance(&user);
    let target_shares = 500_0000000i128;
    let assets_paid = vault.mint(&user, &target_shares, &user);

    assert_eq!(vault.balance(&user), target_shares);
    assert!(assets_paid > 0);
    let balance_after = tc.balance(&user);
    assert_eq!(balance_before - balance_after, assets_paid);
}

// ===========================================================================
// Strategy execution tests (A3/A4/B4/B5) - full execute_strategy: nonce,
// deadline, cooldown, slippage, floor guardrail, NAV invariant, event.
// ===========================================================================

/// B5 - the decisive empirical invariant: a swap at the fair (oracle) price
/// leaves NAV - and therefore share price (supply unchanged) - unchanged.
/// Converting base→risky at fair value neither creates nor destroys value.
/// If NAV jumps, the risky leg is being double-counted or mis-priced.
#[test]
fn test_strategy_fair_swap_preserves_nav() {
    let e = Env::default();
    let f = setup_strategy(&e);
    let vault = StrategyVaultContractClient::new(&e, &f.vault);
    let oracle = MockReflectorClient::new(&e, &f.oracle);
    let router = MockRouterClient::new(&e, &f.router);

    vault.deposit(&f.user, &1_000_0000000i128, &f.user);
    let supply = vault.total_supply();
    oracle.set(&symbol_short!("RSK"), &(2 * PRICE_SCALE), &(2 * PRICE_SCALE), &100_000u64); // 1 risky = 2 base

    let nav_before = vault.total_assets();

    // Swap 100 base → 50 risky (fair: 100 / 2).
    let amount_in = 100_0000000i128;
    let fair_out = amount_in / 2;
    router.set_out(&fair_out);
    vault.execute_strategy(
        &f.op, &f.router, &f.base, &f.risky, &amount_in, &fair_out, &0u64, &200_000u64, &Vec::new(&e),
    );

    assert_eq!(vault.total_supply(), supply, "supply must not change on a swap");
    assert_eq!(
        vault.total_assets(),
        nav_before,
        "fair-price swap must preserve NAV (and thus share price)"
    );
    assert_eq!(vault.get_nonce(), 1, "nonce must increment on success");
}

#[test]
fn test_strategy_emits_event() {
    let e = Env::default();
    let f = setup_strategy(&e);
    let vault = StrategyVaultContractClient::new(&e, &f.vault);
    let oracle = MockReflectorClient::new(&e, &f.oracle);
    let router = MockRouterClient::new(&e, &f.router);

    vault.deposit(&f.user, &1_000_0000000i128, &f.user);
    oracle.set(&symbol_short!("RSK"), &(2 * PRICE_SCALE), &(2 * PRICE_SCALE), &100_000u64);
    let amount_in = 100_0000000i128;
    let out = amount_in / 2;
    router.set_out(&out);
    vault.execute_strategy(
        &f.op, &f.router, &f.base, &f.risky, &amount_in, &out, &0u64, &200_000u64, &Vec::new(&e),
    );

    let vault_events = e.events().all().filter_by_contract(&f.vault);
    assert_eq!(
        vault_events,
        std::vec![events::StrategyExecuted {
            operator: f.op.clone(),
            nonce: 0,
            token_in: f.base.clone(),
            token_out: f.risky.clone(),
            amount_in,
            amount_out: out,
            nav_before: 1_000_0000000,
            nav_after: 1_000_0000000,
        }
        .to_xdr(&e, &f.vault)],
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #24)")] // SlippageExceeded
fn test_strategy_slippage_rejected() {
    let e = Env::default();
    let f = setup_strategy(&e);
    let vault = StrategyVaultContractClient::new(&e, &f.vault);
    let oracle = MockReflectorClient::new(&e, &f.oracle);
    let router = MockRouterClient::new(&e, &f.router);

    vault.deposit(&f.user, &1_000_0000000i128, &f.user);
    oracle.set(&symbol_short!("RSK"), &(2 * PRICE_SCALE), &(2 * PRICE_SCALE), &100_000u64);
    router.set_out(&40_0000000i128); // delivers 40 < min 50
    vault.execute_strategy(
        &f.op, &f.router, &f.base, &f.risky, &100_0000000i128, &50_0000000i128, &0u64, &200_000u64, &Vec::new(&e),
    );
}

/// A compromised operator must not be able to route through a contract of
/// their own: the venue (router) is allowlisted like the tokens are.
#[test]
#[should_panic(expected = "Error(Contract, #29)")] // RouterNotAllowed
fn test_strategy_unlisted_router_rejected() {
    let e = Env::default();
    let f = setup_strategy(&e);
    let vault = StrategyVaultContractClient::new(&e, &f.vault);
    let oracle = MockReflectorClient::new(&e, &f.oracle);

    vault.deposit(&f.user, &1_000_0000000i128, &f.user);
    oracle.set(&symbol_short!("RSK"), &(2 * PRICE_SCALE), &(2 * PRICE_SCALE), &100_000u64);

    // Registered and funded, but never allowlisted in the config.
    let rogue_router = e.register(MockRouter, ());
    MockRouterClient::new(&e, &rogue_router).set_out(&50_0000000i128);
    vault.execute_strategy(
        &f.op, &rogue_router, &f.base, &f.risky, &100_0000000i128, &50_0000000i128, &0u64,
        &200_000u64, &Vec::new(&e),
    );
}

/// The oracle slippage cap is a protocol bound the operator cannot loosen: a
/// colluding `min_amount_out` of 1 must not let a bad fill through. Fair out
/// is 50 (oracle: 1 risky = 2 base); the router delivers 40 (-20%), far past
/// the 1% cap.
#[test]
#[should_panic(expected = "Error(Contract, #43)")] // SlippageCapExceeded
fn test_strategy_oracle_slippage_cap_rejected() {
    let e = Env::default();
    let f = setup_strategy(&e);
    let vault = StrategyVaultContractClient::new(&e, &f.vault);
    let oracle = MockReflectorClient::new(&e, &f.oracle);
    let router = MockRouterClient::new(&e, &f.router);

    vault.deposit(&f.user, &1_000_0000000i128, &f.user);
    oracle.set(&symbol_short!("RSK"), &(2 * PRICE_SCALE), &(2 * PRICE_SCALE), &100_000u64);
    router.set_out(&40_0000000i128);
    vault.execute_strategy(
        &f.op, &f.router, &f.base, &f.risky, &100_0000000i128, &1i128, &0u64, &200_000u64,
        &Vec::new(&e),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #23)")] // CooldownNotElapsed
fn test_strategy_cooldown_rejected() {
    let e = Env::default();
    let f = setup_strategy(&e);
    let vault = StrategyVaultContractClient::new(&e, &f.vault);
    let oracle = MockReflectorClient::new(&e, &f.oracle);
    let router = MockRouterClient::new(&e, &f.router);

    vault.deposit(&f.user, &1_000_0000000i128, &f.user);
    oracle.set(&symbol_short!("RSK"), &(2 * PRICE_SCALE), &(2 * PRICE_SCALE), &100_000u64);
    let out = 50_0000000i128;
    router.set_out(&out);
    // First trade succeeds (sets last_trade_time = 100_000, nonce → 1).
    vault.execute_strategy(
        &f.op, &f.router, &f.base, &f.risky, &100_0000000i128, &out, &0u64, &200_000u64, &Vec::new(&e),
    );
    // Second trade at the same ledger time is inside the 60s cooldown.
    vault.execute_strategy(
        &f.op, &f.router, &f.base, &f.risky, &100_0000000i128, &out, &1u64, &200_000u64, &Vec::new(&e),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #26)")] // NonceMismatch
fn test_strategy_nonce_replay_rejected() {
    let e = Env::default();
    let f = setup_strategy(&e);
    let vault = StrategyVaultContractClient::new(&e, &f.vault);
    let oracle = MockReflectorClient::new(&e, &f.oracle);
    let router = MockRouterClient::new(&e, &f.router);

    vault.deposit(&f.user, &1_000_0000000i128, &f.user);
    oracle.set(&symbol_short!("RSK"), &(2 * PRICE_SCALE), &(2 * PRICE_SCALE), &100_000u64);
    let out = 50_0000000i128;
    router.set_out(&out);
    vault.execute_strategy(
        &f.op, &f.router, &f.base, &f.risky, &100_0000000i128, &out, &0u64, &200_000u64, &Vec::new(&e),
    );
    // Replaying nonce 0 (now expecting 1) is rejected before any other check.
    vault.execute_strategy(
        &f.op, &f.router, &f.base, &f.risky, &100_0000000i128, &out, &0u64, &200_000u64, &Vec::new(&e),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #27)")] // DeadlineExpired
fn test_strategy_deadline_expired() {
    let e = Env::default();
    let f = setup_strategy(&e);
    let vault = StrategyVaultContractClient::new(&e, &f.vault);
    let oracle = MockReflectorClient::new(&e, &f.oracle);
    let router = MockRouterClient::new(&e, &f.router);

    vault.deposit(&f.user, &1_000_0000000i128, &f.user);
    oracle.set(&symbol_short!("RSK"), &(2 * PRICE_SCALE), &(2 * PRICE_SCALE), &100_000u64);
    router.set_out(&50_0000000i128);
    // Deadline 50_000 is before the current ledger time (100_000).
    vault.execute_strategy(
        &f.op, &f.router, &f.base, &f.risky, &100_0000000i128, &50_0000000i128, &0u64, &50_000u64, &Vec::new(&e),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #28)")] // FloorBreached
fn test_strategy_floor_breached() {
    let e = Env::default();
    let f = setup_strategy(&e);
    let vault = StrategyVaultContractClient::new(&e, &f.vault);
    let oracle = MockReflectorClient::new(&e, &f.oracle);
    let router = MockRouterClient::new(&e, &f.router);

    vault.deposit(&f.user, &1_000_0000000i128, &f.user);
    oracle.set(&symbol_short!("RSK"), &(2 * PRICE_SCALE), &(2 * PRICE_SCALE), &100_000u64);
    // Swap 500 base → 250 risky (fair). Post-trade base = 500 of NAV 1000 = 50%
    // < 60% floor → rejected, even though the swap itself is fair and slippage-OK.
    let out = 250_0000000i128;
    router.set_out(&out);
    vault.execute_strategy(
        &f.op, &f.router, &f.base, &f.risky, &500_0000000i128, &out, &0u64, &200_000u64, &Vec::new(&e),
    );
}

#[test]
fn test_strategy_floor_compliant_passes() {
    let e = Env::default();
    let f = setup_strategy(&e);
    let vault = StrategyVaultContractClient::new(&e, &f.vault);
    let oracle = MockReflectorClient::new(&e, &f.oracle);
    let router = MockRouterClient::new(&e, &f.router);

    vault.deposit(&f.user, &1_000_0000000i128, &f.user);
    oracle.set(&symbol_short!("RSK"), &(2 * PRICE_SCALE), &(2 * PRICE_SCALE), &100_000u64);
    // Swap 300 base → 150 risky: post-trade base = 700 of NAV 1000 = 70% ≥ 60%.
    let out = 150_0000000i128;
    router.set_out(&out);
    vault.execute_strategy(
        &f.op, &f.router, &f.base, &f.risky, &300_0000000i128, &out, &0u64, &200_000u64, &Vec::new(&e),
    );
    assert_eq!(vault.get_nonce(), 1);
}

#[test]
fn test_preview_mint_rounds_up() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);

    vault.deposit(&user, &1_000_0000000i128, &user);

    let shares = 100_0000000i128;
    let preview = vault.preview_mint(&shares);
    let preview_redeem = vault.preview_redeem(&shares);

    // preview_mint rounds UP (user pays more), preview_redeem rounds DOWN
    assert!(preview >= preview_redeem);
}

// ===========================================================================
// Fee tests - management (1%/yr) + performance (20% over high-water mark).
// Fees are paid as shares minted to the fee recipient.
// ===========================================================================

#[test]
fn test_management_fee_accrues() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    // Enable 1% mgmt / 20% perf; route fees to a dedicated recipient.
    vault.set_config(&fee_config(&e, &token_addr, 100, 2000));
    let recipient = Address::generate(&e);
    vault.set_fee_recipient(&recipient);

    vault.deposit(&user, &1_000_0000000i128, &user); // NAV 1000; share price == HWM (no profit)
    let supply_before = vault.total_supply();

    // Advance exactly one year → management fee = 1% of NAV.
    e.ledger().set_timestamp(31_536_000);
    let (mgmt, perf) = vault.collect_fees();
    assert_eq!(perf, 0, "no profit → no perf fee");
    assert_eq!(mgmt, 10_0000000, "mgmt fee = 1% of 1000 = 10");

    // ~1% of the pre-fee supply is minted to the recipient.
    let recip = vault.balance(&recipient);
    let expected = supply_before / 100;
    assert!(recip > 0, "recipient must receive mgmt-fee shares");
    let diff = (recip - expected).abs();
    assert!(diff * 100 < expected, "mgmt fee ≈ 1% of supply (got {}, exp {})", recip, expected);
}

#[test]
fn test_performance_fee_and_high_water_mark() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    vault.set_config(&fee_config(&e, &token_addr, 100, 2000));
    let recipient = Address::generate(&e);
    vault.set_fee_recipient(&recipient);

    vault.deposit(&user, &1_000_0000000i128, &user); // NAV 1000; share price == HWM
    let supply_before = vault.total_supply();

    // Simulate +200 XLM yield by donating base directly to the vault (NAV → 1200).
    // Time is not advanced, so the management fee is ~0 (isolates perf).
    tc.transfer(&user, &vault_addr, &200_0000000i128);

    let (mgmt, perf) = vault.collect_fees();
    assert_eq!(mgmt, 0, "no time elapsed → no mgmt fee");
    assert_eq!(perf, 40_0000000, "perf fee = 20% of 200 profit = 40");

    // ~40 XLM worth of shares minted (≈ perf_fee * supply / NAV).
    let recip1 = vault.balance(&recipient);
    let expected1 = 40_0000000i128 * supply_before / 1_200_0000000i128;
    assert!(recip1 > 0, "recipient must receive perf-fee shares");
    let diff1 = (recip1 - expected1).abs();
    assert!(diff1 * 50 < expected1, "perf fee ≈ 20% of profit (got {}, exp {})", recip1, expected1);

    // HWM ratcheted up → a second collect with no new profit charges no perf fee.
    let (_, perf2) = vault.collect_fees();
    assert_eq!(perf2, 0, "HWM prevents charging the same gain twice");
}

// ===========================================================================
// Event emission tests (A1) - schema locked in events.rs / README Appendix A.
// Each asserts the EXACT vault-emitted event sequence (filter_by_contract),
// which also proves internal helpers never double-emit.
// ===========================================================================

#[test]
fn test_event_deposit_emitted() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);

    let assets = 1_000_0000000i128;
    let shares = vault.deposit(&user, &assets, &user);

    let vault_events = e.events().all().filter_by_contract(&vault_addr);
    assert_eq!(
        vault_events,
        std::vec![events::Deposit {
            from: user.clone(),
            receiver: user.clone(),
            assets,
            shares,
        }
        .to_xdr(&e, &vault_addr)],
    );
}

#[test]
fn test_event_withdraw_emitted() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);

    let assets = 1_000_0000000i128;
    vault.deposit(&user, &assets, &user);
    let w_assets = 400_0000000i128;
    let burned = vault.withdraw(&user, &w_assets, &user);

    // `all()` returns events from the most recent invocation (the withdraw).
    let vault_events = e.events().all().filter_by_contract(&vault_addr);
    assert_eq!(
        vault_events,
        std::vec![events::Withdraw {
            owner: user.clone(),
            receiver: user.clone(),
            assets: w_assets,
            shares: burned,
        }
        .to_xdr(&e, &vault_addr)],
    );
}

#[test]
fn test_event_transfer_emitted() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    let user2 = Address::generate(&e);

    let assets = 1_000_0000000i128;
    let shares = vault.deposit(&user, &assets, &user);
    let half = shares / 2;
    vault.transfer(&user, &user2, &half);

    // `all()` returns events from the most recent invocation (the transfer).
    let vault_events = e.events().all().filter_by_contract(&vault_addr);
    assert_eq!(
        vault_events,
        std::vec![events::Transfer {
            from: user.clone(),
            to: user2.clone(),
            amount: half,
        }
        .to_xdr(&e, &vault_addr)],
    );
}

#[test]
fn test_event_approve_emitted() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    let spender = Address::generate(&e);

    vault.approve(&user, &spender, &500i128, &10_000u32);

    let vault_events = e.events().all().filter_by_contract(&vault_addr);
    assert_eq!(
        vault_events,
        std::vec![events::Approve {
            from: user.clone(),
            spender: spender.clone(),
            amount: 500,
            expiration_ledger: 10_000,
        }
        .to_xdr(&e, &vault_addr)],
    );
}

// ===========================================================================
// Oracle tests (B2) - Reflector via mock. Cross-rate (risky-in-base via USD),
// staleness guard, and lastprice-vs-recent-prices deviation breaker
// (revert-on-trip). point_vault_at_mock pre-prices the base (XLM) at 1.0 USD,
// so a risky USD price equals its base cross-rate directly.
// OracleStale = #40, OracleDeviation = #41, PriceUnavailable = #42.
// ===========================================================================

#[test]
fn test_oracle_base_is_unit() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, _user);
    e.ledger().set_timestamp(100_000);
    let mock_addr = e.register(MockReflector, ());
    let risky = Address::generate(&e);
    point_vault_at_mock(&e, &vault_addr, &token_addr, &risky, &mock_addr);
    // The base asset priced in the base is exactly 1.0 (no oracle call).
    assert_eq!(vault.safe_price(&token_addr), PRICE_SCALE);
}

#[test]
fn test_oracle_returns_cross_rate() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, _user);
    e.ledger().set_timestamp(100_000);
    let mock_addr = e.register(MockReflector, ());
    let mock = MockReflectorClient::new(&e, &mock_addr);
    let risky = Address::generate(&e);
    point_vault_at_mock(&e, &vault_addr, &token_addr, &risky, &mock_addr);
    // risky at 2.0 USD, base (XLM) at 1.0 USD → cross-rate = 2.0 base/risky.
    mock.set(&symbol_short!("RSK"), &(2 * PRICE_SCALE), &(2 * PRICE_SCALE), &100_000u64);

    assert_eq!(vault.safe_price(&risky), 2 * PRICE_SCALE);
}

#[test]
fn test_oracle_within_deviation_ok() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, _user);
    e.ledger().set_timestamp(100_000);
    let mock_addr = e.register(MockReflector, ());
    let mock = MockReflectorClient::new(&e, &mock_addr);
    let risky = Address::generate(&e);
    point_vault_at_mock(&e, &vault_addr, &token_addr, &risky, &mock_addr);
    // lastprice 4% above the recent mean (< 5% threshold).
    mock.set(&symbol_short!("RSK"), &(104 * PRICE_SCALE / 100), &PRICE_SCALE, &100_000u64);

    assert!(vault.safe_price(&risky) > 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #40)")]
fn test_oracle_rejects_stale_price() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, _user);
    e.ledger().set_timestamp(100_000);
    let mock_addr = e.register(MockReflector, ());
    let mock = MockReflectorClient::new(&e, &mock_addr);
    let risky = Address::generate(&e);
    point_vault_at_mock(&e, &vault_addr, &token_addr, &risky, &mock_addr);
    // Risky quote older than the staleness window.
    mock.set(
        &symbol_short!("RSK"),
        &(2 * PRICE_SCALE),
        &(2 * PRICE_SCALE),
        &(100_000 - TEST_STALENESS - 1),
    );

    vault.safe_price(&risky);
}

#[test]
#[should_panic(expected = "Error(Contract, #41)")]
fn test_oracle_rejects_deviation() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, _user);
    e.ledger().set_timestamp(100_000);
    let mock_addr = e.register(MockReflector, ());
    let mock = MockReflectorClient::new(&e, &mock_addr);
    let risky = Address::generate(&e);
    point_vault_at_mock(&e, &vault_addr, &token_addr, &risky, &mock_addr);
    // lastprice 10% above the recent mean > 5% threshold.
    mock.set(&symbol_short!("RSK"), &(11 * PRICE_SCALE / 10), &PRICE_SCALE, &100_000u64);

    vault.safe_price(&risky);
}

#[test]
#[should_panic(expected = "Error(Contract, #42)")]
fn test_oracle_zero_price_unavailable() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, _user);
    e.ledger().set_timestamp(100_000);
    let mock_addr = e.register(MockReflector, ());
    let mock = MockReflectorClient::new(&e, &mock_addr);
    let risky = Address::generate(&e);
    point_vault_at_mock(&e, &vault_addr, &token_addr, &risky, &mock_addr);
    mock.set(&symbol_short!("RSK"), &0i128, &0i128, &100_000u64);

    vault.safe_price(&risky);
}

#[test]
#[should_panic(expected = "Error(Contract, #42)")]
fn test_oracle_price_unavailable() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, _user);
    e.ledger().set_timestamp(100_000);
    let mock_addr = e.register(MockReflector, ()); // RSK never configured → None
    let risky = Address::generate(&e);
    point_vault_at_mock(&e, &vault_addr, &token_addr, &risky, &mock_addr);

    vault.safe_price(&risky);
}

// ===========================================================================
// Multi-asset NAV tests (B3) - total_assets = base + Σ(risky × oracle price).
// total_assets is the single chokepoint share price funnels through.
// ===========================================================================

#[test]
fn test_nav_zero_risky_equals_base() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    e.ledger().set_timestamp(100_000);
    vault.deposit(&user, &1_000_0000000i128, &user);

    // Allowlist a real risky token but hold none of it → NAV stays base-only,
    // and no oracle call is made (loop skips zero balances).
    let risky_addr = e.register_stellar_asset_contract_v2(admin.clone()).address();
    let mock_addr = e.register(MockReflector, ());
    point_vault_at_mock(&e, &vault_addr, &token_addr, &risky_addr, &mock_addr);

    assert_eq!(vault.total_assets(), 1_000_0000000);
}

#[test]
fn test_nav_includes_risky_leg() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    e.ledger().set_timestamp(100_000);
    vault.deposit(&user, &1_000_0000000i128, &user); // 1000.0 base

    // Simulate a post-swap holding: give the vault 10.0 of a risky token.
    let risky_addr = e.register_stellar_asset_contract_v2(admin.clone()).address();
    let risky_sac = token::StellarAssetClient::new(&e, &risky_addr);
    risky_sac.mint(&vault_addr, &10_0000000i128);

    // Oracle: 1 risky = 3 base (14-dec price), price == twap, fresh.
    let mock_addr = e.register(MockReflector, ());
    let mock = MockReflectorClient::new(&e, &mock_addr);
    point_vault_at_mock(&e, &vault_addr, &token_addr, &risky_addr, &mock_addr);
    mock.set(&symbol_short!("RSK"), &(3 * PRICE_SCALE), &(3 * PRICE_SCALE), &100_000u64);

    // NAV = 1000.0 base + 10.0 risky × 3 = 1030.0 (base, 7-dec)
    assert_eq!(vault.total_assets(), 1_000_0000000 + 30_0000000);
}

#[test]
#[should_panic(expected = "Error(Contract, #40)")]
fn test_nav_reverts_on_stale_oracle_with_risky() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    e.ledger().set_timestamp(100_000);
    vault.deposit(&user, &1_000_0000000i128, &user);

    let risky_addr = e.register_stellar_asset_contract_v2(admin.clone()).address();
    let risky_sac = token::StellarAssetClient::new(&e, &risky_addr);
    risky_sac.mint(&vault_addr, &10_0000000i128);

    // Stale quote → NAV cannot be computed → revert (documented limitation).
    let mock_addr = e.register(MockReflector, ());
    let mock = MockReflectorClient::new(&e, &mock_addr);
    point_vault_at_mock(&e, &vault_addr, &token_addr, &risky_addr, &mock_addr);
    mock.set(
        &symbol_short!("RSK"),
        &(3 * PRICE_SCALE),
        &(3 * PRICE_SCALE),
        &(100_000 - TEST_STALENESS - 1),
    );

    vault.total_assets();
}

// ===========================================================================
// Pause / guardian tests (A2) - OZ Pausable. Pause halts deposit/mint/strategy;
// withdraw/redeem stay callable (User Exit Guarantee). EnforcedPause = #1000.
// ===========================================================================

#[test]
fn test_guardian_defaults_to_admin() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, _user);
    assert_eq!(vault.get_guardian(), admin);
    assert!(!vault.paused());
}

#[test]
#[should_panic(expected = "Error(Contract, #1000)")]
fn test_pause_blocks_deposit() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    vault.pause(&admin);
    assert!(vault.paused());
    vault.deposit(&user, &1_000_0000000i128, &user);
}

#[test]
#[should_panic(expected = "Error(Contract, #1000)")]
fn test_pause_blocks_strategy() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    let router = Address::generate(&e);
    vault.deposit(&user, &1_000_0000000i128, &user);
    vault.pause(&admin);
    vault.execute_strategy(
        &op, &router, &token_addr, &token_addr,
        &100_0000000i128, &90_0000000i128, &0u64, &200_000u64, &Vec::new(&e),
    );
}

#[test]
fn test_pause_allows_withdraw() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    vault.deposit(&user, &1_000_0000000i128, &user);
    vault.pause(&admin);

    // Exit guarantee: withdraw remains callable while paused.
    let max_w = vault.max_withdraw(&user);
    vault.withdraw(&user, &max_w, &user);
    assert_eq!(vault.balance(&user), 0);
}

#[test]
fn test_unpause_restores_deposit() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    vault.pause(&admin);
    vault.unpause(&admin);
    assert!(!vault.paused());
    let shares = vault.deposit(&user, &1_000_0000000i128, &user);
    assert!(shares > 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #25)")]
fn test_pause_unauthorized_caller() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    vault.pause(&user); // neither guardian nor admin
}

#[test]
fn test_set_guardian_then_pause() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, _user);
    let guardian = Address::generate(&e);
    vault.set_guardian(&guardian);
    assert_eq!(vault.get_guardian(), guardian);
    vault.pause(&guardian); // delegated guardian can pause
    assert!(vault.paused());
}

#[test]
fn test_pause_emits_event() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, _user);
    vault.pause(&admin);
    let vault_events = e.events().all().filter_by_contract(&vault_addr);
    assert_eq!(
        vault_events,
        std::vec![pausable::Paused {}.to_xdr(&e, &vault_addr)],
    );
}

#[test]
fn test_event_burn_emitted() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);

    let assets = 1_000_0000000i128;
    let shares = vault.deposit(&user, &assets, &user);
    let burn_amt = shares / 4;
    vault.burn(&user, &burn_amt);

    // `all()` returns events from the most recent invocation (the burn).
    let vault_events = e.events().all().filter_by_contract(&vault_addr);
    assert_eq!(
        vault_events,
        std::vec![events::Burn {
            from: user.clone(),
            amount: burn_amt,
        }
        .to_xdr(&e, &vault_addr)],
    );
}
