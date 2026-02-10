#![cfg(test)]

use crate::storage::StrategyConfig;
use crate::{StrategyVaultContract, StrategyVaultContractClient};
use soroban_sdk::{
    testutils::Address as _,
    token, Address, Env, String, Vec,
};

// ===========================================================================
// Test setup macro — avoids lifetime issues with clients
// ===========================================================================

macro_rules! setup {
    ($e:ident, $token_addr:ident, $sac:ident, $tc:ident,
     $vault_addr:ident, $vault:ident,
     $admin:ident, $op:ident, $user:ident) => {
        let $e = Env::default();
        $e.mock_all_auths();

        let $admin = Address::generate(&$e);
        let $op = Address::generate(&$e);
        let $user = Address::generate(&$e);

        let $token_addr = $e.register_stellar_asset_contract_v2($admin.clone()).address();
        let $sac = token::StellarAssetClient::new(&$e, &$token_addr);
        let $tc = token::Client::new(&$e, &$token_addr);

        let $vault_addr: Address = $e.register_contract(None, StrategyVaultContract);
        let $vault = StrategyVaultContractClient::new(&$e, &$vault_addr);

        let mut allowed = Vec::new(&$e);
        allowed.push_back($token_addr.clone());
        let config = StrategyConfig {
            max_trade_size: 1_000_000_0000000,
            cooldown_period: 60,
            allowed_tokens: allowed,
        };

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
    let vault_addr: Address = e.register_contract(None, StrategyVaultContract);
    let vault = StrategyVaultContractClient::new(&e, &vault_addr);

    let mut allowed = Vec::new(&e);
    allowed.push_back(token_addr.clone());
    let config = StrategyConfig {
        max_trade_size: 1_000_000_0000000,
        cooldown_period: 60,
        allowed_tokens: allowed,
    };

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
    let vault_addr: Address = e.register_contract(None, StrategyVaultContract);
    let vault = StrategyVaultContractClient::new(&e, &vault_addr);

    let mut allowed = Vec::new(&e);
    allowed.push_back(token_addr.clone());
    let config = StrategyConfig {
        max_trade_size: 1_000_000_0000000,
        cooldown_period: 60,
        allowed_tokens: allowed,
    };

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

    // Rounding down both ways — back should be <= original
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

    // user is not the operator — should fail
    vault.execute_strategy(
        &user, &router, &token_addr, &token_addr,
        &100_0000000i128, &90_0000000i128, &Vec::new(&e),
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
        &100_0000000i128, &90_0000000i128, &Vec::new(&e),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #22)")]
fn test_strategy_trade_size_exceeded() {
    setup!(e, token_addr, sac, tc, vault_addr, vault, admin, op, user);
    let router = Address::generate(&e);

    vault.deposit(&user, &1_000_0000000i128, &user);

    // Exceed max trade size (default 1,000,000 tokens)
    vault.execute_strategy(
        &op, &router, &token_addr, &token_addr,
        &2_000_000_0000000i128, &1_000_000_0000000i128, &Vec::new(&e),
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

    // Victim deposits — should still get a non-trivial share amount
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
    let new_config = StrategyConfig {
        max_trade_size: 500_0000000,
        cooldown_period: 120,
        allowed_tokens: allowed,
    };

    vault.set_config(&new_config);
    let stored = vault.get_config();
    assert_eq!(stored.max_trade_size, 500_0000000);
    assert_eq!(stored.cooldown_period, 120);
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
