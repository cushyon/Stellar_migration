import { xdr, nativeToScVal } from "@stellar/stellar-sdk";
import { config } from "./config.js";
import { readContract, addressArg, invokeContract, ContractCallError } from "./stellar.js";
import type { VaultConfig } from "./risk.js";

const PRICE_SCALE = 1e14; // the vault returns prices with 14 decimals
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

type Log = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };

/// Testnet only: keep the Soroswap pool of the two vault legs at the oracle price.
///
/// On mainnet, arbitrage traders bring a pool back to the market price within
/// seconds, so the vault can hold its 1% oracle cap (`max_slippage_bps`). The
/// testnet has no arbitrage traders: a pool drifts away from the feed as soon
/// as the real price moves, and the vault then refuses every trade with error
/// 43, which is the correct behaviour. This step plays the arbitrage trader,
/// with test tokens, so the same cap can stay on testnet as on mainnet. It
/// never runs outside the testnet passphrase, whatever the setting says.
export async function alignPool(log?: Log): Promise<void> {
  const settings = config.poolAlign;
  if (!settings.enabled) return;
  if (config.networkPassphrase !== TESTNET_PASSPHRASE) {
    log?.warn("[pool-align] enabled outside the testnet: refused");
    return;
  }
  if (!settings.routerId || !config.keeper.operatorSecret || !config.keeper.operatorPublicKey) {
    log?.warn("[pool-align] SOROSWAP_ROUTER_ID or the operator key is missing, step skipped");
    return;
  }

  const vault = config.keeper.vaultId;
  const cfg = (await readContract(vault, "get_config")) as VaultConfig;
  const base = config.baseAssetId;
  const safe = cfg.safe_asset;
  const operator = config.keeper.operatorPublicKey;

  // The pool and its reserves, in the order of the pair.
  const factory = (await readContract(settings.routerId, "get_factory")) as string;
  const pair = (await readContract(factory, "get_pair", [addressArg(base), addressArg(safe)])) as string;
  const token0 = (await readContract(pair, "token_0")) as string;
  const [r0, r1] = (await readContract(pair, "get_reserves")) as [bigint, bigint];
  const reserveBase = Number(token0 === base ? r0 : r1);
  const reserveSafe = Number(token0 === base ? r1 : r0);
  if (!(reserveBase > 0) || !(reserveSafe > 0)) return;

  // Feed: base units per one safe unit, from the vault itself.
  const feed = Number((await readContract(vault, "safe_price", [addressArg(safe)])) as bigint) / PRICE_SCALE;
  const pool = reserveBase / reserveSafe;
  const deviationBps = ((pool - feed) / feed) * 10_000;
  if (Math.abs(deviationBps) <= settings.toleranceBps) return;

  // Constant product: move the reserves to the feed ratio. The pool takes its
  // fee on the input, so the input is scaled up by it.
  const k = reserveBase * reserveSafe;
  const fee = 1 - settings.feeBps / 10_000;
  const baseIsCheap = pool > feed; // more base per safe than the feed says
  const tokenIn = baseIsCheap ? safe : base;
  const tokenOut = baseIsCheap ? base : safe;
  const reserveIn = baseIsCheap ? reserveSafe : reserveBase;
  const reserveOut = baseIsCheap ? reserveBase : reserveSafe;
  const effectiveIn = (baseIsCheap ? Math.sqrt(k / feed) : Math.sqrt(k * feed)) - reserveIn;
  let amountIn = Math.floor(effectiveIn / fee);
  if (amountIn <= 0) return;

  // Pay with what the operator holds. Keep XLM aside for fees. When the safe
  // test token runs out, ask the Soroswap testnet faucet once and try again
  // on the next cycle.
  const held = Number((await readContract(tokenIn, "balance", [addressArg(operator)])) as bigint);
  const available = tokenIn === base ? held - settings.baseReserveKept : held;
  if (available < amountIn) {
    if (tokenIn === safe && settings.faucetUrl) {
      await askFaucet(settings.faucetUrl, operator, safe, log);
    }
    if (available < settings.minAmountIn) {
      log?.warn(`[pool-align] not enough ${tokenIn === base ? "base" : "safe"} tokens: has ${held}, needs ${amountIn}`);
      return;
    }
    amountIn = available;
  }

  const amountInEffective = amountIn * fee;
  const expectedOut = (reserveOut * amountInEffective) / (reserveIn + amountInEffective);
  const minOut = BigInt(Math.floor(expectedOut * (1 - settings.slippageBps / 10_000)));
  const deadline = Math.floor(Date.now() / 1000) + config.keeper.deadlineSeconds;

  const args = [
    nativeToScVal(BigInt(amountIn), { type: "i128" }),
    nativeToScVal(minOut, { type: "i128" }),
    xdr.ScVal.scvVec([addressArg(tokenIn), addressArg(tokenOut)]),
    addressArg(operator),
    nativeToScVal(deadline, { type: "u64" }),
  ];
  const side = baseIsCheap ? "sold safe for base" : "sold base for safe";
  try {
    const { hash } = await invokeContract(settings.routerId, "swap_exact_tokens_for_tokens", args, config.keeper.operatorSecret);
    log?.info(
      `[pool-align] pool ${pool.toFixed(4)} feed ${feed.toFixed(4)} (${deviationBps > 0 ? "+" : ""}${(deviationBps / 100).toFixed(2)}%): ` +
        `${side}, amount_in=${amountIn} tx=${hash}`
    );
  } catch (e) {
    const error = e as ContractCallError;
    log?.warn(`[pool-align] swap failed: ${error.message.slice(0, 200)}`);
  }
}

/// The Soroswap testnet faucet mints its test tokens to any address.
async function askFaucet(url: string, address: string, token: string, log?: Log): Promise<void> {
  try {
    const response = await fetch(`${url}?address=${address}&contract=${token}`, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
    });
    log?.info(`[pool-align] faucet asked for ${token}: HTTP ${response.status}`);
  } catch (e) {
    log?.warn(`[pool-align] faucet call failed: ${(e as Error).message}`);
  }
}
