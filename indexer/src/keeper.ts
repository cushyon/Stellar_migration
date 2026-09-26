import { Prisma } from "@prisma/client";
import { xdr, nativeToScVal } from "@stellar/stellar-sdk";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { readContract, addressArg, invokeContract, ContractCallError } from "./stellar.js";
import { askEngine } from "./engine.js";
import { takeRiskSnapshot } from "./risk.js";

const PRICE_SCALE = 1e14; // the vault returns prices with 14 decimals

type Log = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };

/// One keeper cycle: read the vault, ask the engine for the target allocation,
/// and send one trade when the drift is large enough. Every decision is stored,
/// including the ones that send nothing.
///
/// The vault checks the trade again onchain. The keeper can only propose.
export async function runKeeper(log?: Log): Promise<void> {
  if (!config.keeper.enabled) return;
  const vault = config.keeper.vaultId;
  const risky = config.keeper.riskyAssetId;
  const router = config.keeper.routerId;

  if (!risky || !router) {
    log?.warn("[keeper] KEEPER_RISKY_ASSET_ID or KEEPER_ROUTER_ID missing, cycle skipped");
    return;
  }

  const cfg = (await readContract(vault, "get_config")) as {
    max_trade_size: bigint;
    cooldown_period: bigint;
  };

  // The vault refuses a trade inside the cooldown. Check it here too, so a
  // cycle that cannot trade costs one RPC read and writes no noisy row.
  const lastSubmitted = await prisma.strategyRun.findFirst({
    where: { vault, status: "submitted" },
    orderBy: { ts: "desc" },
  });
  if (lastSubmitted) {
    const elapsed = (Date.now() - lastSubmitted.ts.getTime()) / 1000;
    if (elapsed < Number(cfg.cooldown_period)) {
      log?.info(`[keeper] cooldown: ${Math.round(Number(cfg.cooldown_period) - elapsed)}s left`);
      return;
    }
  }

  // After a rejection, wait instead of sending the same proposal again. A vault
  // that refuses a trade now usually refuses the same trade one cycle later.
  const lastRun = await prisma.strategyRun.findFirst({ where: { vault }, orderBy: { ts: "desc" } });
  if (lastRun?.status === "rejected" && config.keeper.rejectBackoffSeconds > 0) {
    const elapsed = (Date.now() - lastRun.ts.getTime()) / 1000;
    if (elapsed < config.keeper.rejectBackoffSeconds) {
      log?.info(
        `[keeper] backoff after error ${lastRun.errorCode ?? "unknown"}: ` +
          `${Math.round(config.keeper.rejectBackoffSeconds - elapsed)}s left`
      );
      return;
    }
  }

  const risk = await takeRiskSnapshot(vault, log);
  if (risk.paused) return hold(vault, "vault is paused", log);
  if (!risk.oracleOk) return hold(vault, "oracle unavailable", log);
  if (risk.supply === 0n) return hold(vault, "vault has no shares", log);

  // Price of one risky unit in base units, from the vault itself, so the keeper
  // and the contract value the leg the same way.
  const riskyPrice =
    Number((await readContract(vault, "safe_price", [addressArg(risky)])) as bigint) / PRICE_SCALE;
  if (!(riskyPrice > 0)) return hold(vault, "risky price is zero", log);

  const riskyBalance = BigInt(
    (await readContract(risky, "balance", [addressArg(vault)])) as bigint
  );

  // Per-share values: a deposit or a withdrawal must not change the target.
  const supply = Number(risk.supply);
  const navPerShare = Number(risk.nav) / supply;
  const state = await loadState(vault, navPerShare);
  const maxSharePrice = Math.max(state.maxSharePrice, navPerShare);

  const answer = await askEngine({
    price_risky: riskyPrice,
    price_safe: 1,
    nav: navPerShare,
    max_nav: maxSharePrice,
    risky_amount: Number(riskyBalance) / supply,
    safe_amount: Number(risk.baseBalance) / supply,
    initial_capital: state.initialSharePrice,
  });

  await prisma.strategyState.update({
    where: { vault },
    data: { maxSharePrice: answer.newMaxNav, lastLimitOrderPrice: answer.limitOrderPrice },
  });

  // Drift between the target risky value and the current one, in base units.
  const navTotal = Number(risk.nav);
  const targetRiskyValue = (answer.percentageAsset1 / 100) * navTotal;
  const actualRiskyValue = Number(riskyBalance) * riskyPrice;
  const delta = targetRiskyValue - actualRiskyValue;
  const driftPct = Math.abs(delta) / navTotal;
  const actualRiskyPct = (actualRiskyValue / navTotal) * 100;

  const common = {
    targetRiskyPct: answer.percentageAsset1,
    actualRiskyPct,
    detail: `limit order ${answer.limitOrderPrice.toFixed(6)}, ratchet steps ${answer.ratchetSteps}`,
  };

  if (driftPct * 10_000 < config.keeper.driftBps) {
    return hold(vault, `drift ${(driftPct * 100).toFixed(2)}% below the threshold`, log, common);
  }

  // Direction: buy the risky leg with base, or sell it back to base.
  const buy = delta > 0;
  const tokenIn = buy ? config.baseAssetId : risky;
  const tokenOut = buy ? risky : config.baseAssetId;
  const priceIn = buy ? 1 : riskyPrice;
  const priceOut = buy ? riskyPrice : 1;

  const maxTrade = BigInt(cfg.max_trade_size);
  let amountIn = BigInt(Math.floor(Math.abs(delta) / priceIn));
  if (amountIn > maxTrade) amountIn = maxTrade;
  if (amountIn <= 0n) return hold(vault, "amount rounds to zero", log, common);

  const expectedOut = (Number(amountIn) * priceIn) / priceOut;
  const minOut = BigInt(Math.floor((expectedOut * (10_000 - config.keeper.slippageBps)) / 10_000));
  const nonce = Number((await readContract(vault, "get_nonce")) as bigint);
  const deadline = Math.floor(Date.now() / 1000) + config.keeper.deadlineSeconds;
  const action = buy ? "buy_risky" : "sell_risky";

  const args = [
    addressArg(config.keeper.operatorPublicKey),
    addressArg(router),
    addressArg(tokenIn),
    addressArg(tokenOut),
    nativeToScVal(amountIn, { type: "i128" }),
    nativeToScVal(minOut, { type: "i128" }),
    nativeToScVal(nonce, { type: "u64" }),
    nativeToScVal(deadline, { type: "u64" }),
    xdr.ScVal.scvVec([]),
  ];

  if (config.keeper.dryRun || !config.keeper.operatorSecret) {
    log?.info(`[keeper] dry run ${action} amount_in=${amountIn} min_out=${minOut} nonce=${nonce}`);
    return record(vault, action, "dry_run", { ...common, amountIn, minOut, nonce });
  }

  try {
    const { hash } = await invokeContract(vault, "execute_strategy", args, config.keeper.operatorSecret);
    log?.info(`[keeper] ${action} sent, amount_in=${amountIn} tx=${hash}`);
    await record(vault, action, "submitted", { ...common, amountIn, minOut, nonce, txHash: hash });
  } catch (e) {
    const error = e as ContractCallError;
    const message = error.message;
    // A call that never reached the network is a rejection by the vault. After
    // it reaches the network the trade may be onchain, so the run is unknown
    // and an operator must check the hash.
    const status = error.submitted ? "unknown" : "rejected";
    if (error.submitted) log?.error(`[keeper] ${action} sent but unconfirmed, tx=${error.hash}: ${message}`);
    else log?.warn(`[keeper] ${action} rejected by the vault: error ${error.code ?? "unknown"}`);
    await record(vault, action, status, {
      ...common,
      amountIn,
      minOut,
      nonce,
      txHash: error.hash,
      errorCode: error.code ?? null,
      detail: message.slice(0, 300),
    });
  }
}

/// No trade this cycle. It is logged and stored, so a quiet keeper can be told
/// apart from a keeper that never ran.
async function hold(
  vault: string,
  reason: string,
  log?: Log,
  common: { targetRiskyPct?: number; actualRiskyPct?: number } = {}
): Promise<void> {
  log?.info(`[keeper] hold: ${reason}`);
  await record(vault, "hold", "skipped", { ...common, detail: reason });
}

async function loadState(vault: string, sharePrice: number) {
  return prisma.strategyState.upsert({
    where: { vault },
    create: { vault, initialSharePrice: sharePrice, maxSharePrice: sharePrice },
    update: {},
  });
}

async function record(
  vault: string,
  action: string,
  status: string,
  extra: {
    targetRiskyPct?: number;
    actualRiskyPct?: number;
    amountIn?: bigint;
    minOut?: bigint;
    nonce?: number;
    txHash?: string;
    errorCode?: number | null;
    detail?: string;
  } = {}
): Promise<void> {
  await prisma.strategyRun.create({
    data: {
      vault,
      action,
      status,
      targetRiskyPct: extra.targetRiskyPct,
      actualRiskyPct: extra.actualRiskyPct,
      amountIn: extra.amountIn != null ? new Prisma.Decimal(extra.amountIn.toString()) : null,
      minOut: extra.minOut != null ? new Prisma.Decimal(extra.minOut.toString()) : null,
      nonce: extra.nonce,
      txHash: extra.txHash,
      errorCode: extra.errorCode ?? null,
      detail: extra.detail,
    },
  });
}
