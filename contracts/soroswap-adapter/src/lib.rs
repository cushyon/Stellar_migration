#![no_std]
//! Soroswap adapter: the vault trades on a real DEX through this contract.
//!
//! doc-checked (2026-09-27, docs.soroswap.finance technical reference and
//! soroswap/core `contracts/router/src/lib.rs`): the router function is
//! `swap_exact_tokens_for_tokens(amount_in, amount_out_min, path, to, deadline)`,
//! it calls `to.require_auth()`, and it moves the input tokens **from `to`** into
//! the pair. So the adapter names itself as `to`: it pays the input from its own
//! balance, receives the output, and forwards it to the vault.
//!
//! The router asks the token contract to move the adapter's funds, so the adapter
//! is not the direct caller of that transfer and its authorization is not
//! implicit. `authorize_as_current_contract` therefore allows exactly one action:
//! move `amount_in` of `token_in` from the adapter to the pair of this pair of
//! tokens, and nothing else.
//!
//! The vault sends `amount_in` here before it calls `swap`, exactly as its
//! `Router` trait says, and it checks the realized output afterwards against the
//! operator floor, the oracle price, and the protection floor. That is why this
//! adapter passes `amount_out_min = 0`: the vault holds the real bound, in the
//! same transaction, so a bad fill reverts everything.

use soroban_sdk::auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation};
use soroban_sdk::{
    contract, contractclient, contractimpl, symbol_short, token, vec, Address, Env, IntoVal,
    Symbol, Vec,
};

const ROUTER: Symbol = symbol_short!("ROUTER");
/// Seconds added to the ledger time for the router deadline. The swap happens in
/// this same transaction, so the value only has to be in the future.
const DEADLINE_WINDOW: u64 = 60;
/// Instance TTL threshold and target, in ledgers.
const INSTANCE_TTL_LEDGERS: u32 = 100_000;

/// The part of the Soroswap router that the adapter calls.
#[allow(dead_code)]
#[contractclient(name = "SoroswapRouterClient")]
pub trait SoroswapRouter {
    fn swap_exact_tokens_for_tokens(
        e: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128>;
    fn get_factory(e: Env) -> Address;
}

/// The part of the Soroswap factory that the adapter calls.
#[allow(dead_code)]
#[contractclient(name = "SoroswapFactoryClient")]
pub trait SoroswapFactory {
    fn get_pair(e: Env, token_a: Address, token_b: Address) -> Address;
}

#[contract]
pub struct SoroswapAdapter;

#[contractimpl]
impl SoroswapAdapter {
    /// Store the Soroswap router in the deployment transaction. The router cannot
    /// change after this: a new router needs a new adapter. Confirm the id per
    /// network before a deployment: it lives in
    /// `public/<network>.contracts.json` of soroswap/core.
    pub fn __constructor(e: Env, router: Address) {
        e.storage().instance().set(&ROUTER, &router);
        e.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_LEDGERS, INSTANCE_TTL_LEDGERS);
    }

    pub fn router(e: Env) -> Address {
        e.storage().instance().get(&ROUTER).unwrap()
    }

    /// The shape the vault expects (`Router` trait): the vault has already sent
    /// `amount_in` of `token_in` here, and it wants `token_out` back at `to`.
    pub fn swap(e: Env, token_in: Address, token_out: Address, amount_in: i128, to: Address) -> i128 {
        // Each trade keeps the instance live, because no setter extends it now.
        e.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_LEDGERS, INSTANCE_TTL_LEDGERS);
        let router: Address = e.storage().instance().get(&ROUTER).unwrap();
        let me = e.current_contract_address();

        let router_client = SoroswapRouterClient::new(&e, &router);
        let factory = router_client.get_factory();
        let pair = SoroswapFactoryClient::new(&e, &factory).get_pair(&token_in, &token_out);

        // Allow the router to move exactly this input into exactly this pair.
        e.authorize_as_current_contract(vec![
            &e,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: token_in.clone(),
                    fn_name: Symbol::new(&e, "transfer"),
                    args: (me.clone(), pair, amount_in).into_val(&e),
                },
                sub_invocations: vec![&e],
            }),
        ]);

        let mut path = Vec::new(&e);
        path.push_back(token_in);
        path.push_back(token_out.clone());

        let amounts = router_client.swap_exact_tokens_for_tokens(
            &amount_in,
            &0,
            &path,
            &me,
            &(e.ledger().timestamp() + DEADLINE_WINDOW),
        );

        // The last element is what the route delivered.
        let amount_out = amounts.last().unwrap_or(0);
        token::Client::new(&e, &token_out).transfer(&me, &to, &amount_out);
        amount_out
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn router_cannot_change_after_deployment() {
        // No auth mock: the test does not sign for any address.
        let e = Env::default();
        let real_router = Address::generate(&e);
        let fake_router = Address::generate(&e);
        let adapter = e.register(SoroswapAdapter, SoroswapAdapterArgs::__constructor(&real_router));
        let client = SoroswapAdapterClient::new(&e, &adapter);
        assert_eq!(client.router(), real_router);

        for name in ["set_router", "__constructor"] {
            let result = e.try_invoke_contract::<(), soroban_sdk::Error>(
                &adapter,
                &Symbol::new(&e, name),
                (fake_router.clone(),).into_val(&e),
            );
            assert!(result.is_err(), "{name} must not be callable");
        }
        assert_eq!(client.router(), real_router);
    }
}
