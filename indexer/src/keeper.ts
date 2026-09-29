import { Prisma } from "@prisma/client";
import { xdr, nativeToScVal } from "@stellar/stellar-sdk";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { readContract, addressArg, invokeContract, ContractCallError } from "./stellar.js";
import { askEngine } from "./engine.js";
import { takeRiskSnapshot, type VaultConfig } from "./risk.js";
import type { Alert } from "./alerts.js";

const PRICE_SCALE = 1e14; // the vault returns prices with 14 decimals

type Log = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };

/// One keeper cycle: read the vault, ask the engine for the target allocation,
/// and send one trade when the drift is large enough. Every decision is stored,
/// including the ones that send nothing.
///
/// Roles come from the vault config. In the product shape the base asset (XLM)
/// is the risky leg and `safe_asset` (USDC) is the safe leg; the keeper then
/// computes in safe units, with the base priced through the oracle. A vault
/// whose base asset is the safe asset works too, with KEEPER_RISKY_ASSET_ID.
///
/// The vault checks the trade again onchain. The keeper can only propose.
export async function runKeeper(log?: Log): Promise<void> {
  if (!config.keeper.enabled) return;
  const vault = config.keeper.vaultId;
  const router = config.keeper.routerId;
  if (!router) {
    log?.warn("[keeper] KEEPER_ROUTER_ID missing, cycle skipped");
    return;
  }
  if (!config.keeper.operatorSecret || !config.keeper.operatorPublicKey) {
    log?.warn("[keeper] operator key missing, cycle skipped");
    return;
  }

  const cfg = (await readContract(vault, "get_config")) as VaultConfig;
  const base = config.baseAssetId;
  const safe = cfg.safe_asset;
  const baseIsRisky = safe !== base;
  const risky = baseIsRisky ? base : config.keeper.riskyAssetId;
  if (!risky) {
    log?.warn("[keeper] the base asset is the safe asset and KEEPER_RISKY_ASSET_ID is missing, cycle skipped");
    return;
  }

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

  // A run that was sent but never confirmed needs a person to check the hash.
  // Only recent ones: an old row stays "unknown" for ever, and an alert that
  // never clears is an alert that nobody reads.
  const pending = await prisma.strategyRun.findFirst({
    where: {
      vault,
      status: "unknown",
      ts: { gte: new Date(Date.now() - config.keeper.unconfirmedAlertHours * 3_600_000) },
    },
    orderBy: { ts: "desc" },
  });
  const extraAlerts: Alert[] = pending
    ? [{ key: "unconfirmed_trade", message: `a trade was sent but not confirmed: tx ${pending.txHash ?? "unknown"}` }]
    : [];

  const risk = await takeRiskSnapshot(vault, log, extraAlerts);
  if (risk.paused) return hold(vault, "vault is paused", log);
  if (!risk.oracleOk) return hold(vault, "oracle unavailable", log);
  if (risk.supply === 0n) return hold(vault, "vault has no shares", log);
  if (!risk.epoch.active) return hold(vault, "no epoch started: the admin must call start_epoch", log);

  // Prices in base units, from the vault itself, so the keeper and the contract
  // value every leg the same way. The base is worth exactly 1 base.
  const priceInBase = async (token: string) =>
    token === base ? 1 : Number((await readContract(vault, "safe_price", [addressArg(token)])) as bigint) / PRICE_SCALE;
  const safeInBase = await priceInBase(safe);
  const riskyInBase = await priceInBase(risky);
  if (!(safeInBase > 0) || !(riskyInBase > 0)) return hold(vault, "a price is zero", log);

  const balanceOf = async (token: string) =>
    token === base ? risk.baseBalance : BigInt((await readContract(token, "balance", [addressArg(vault)])) as bigint);
  const riskyBalance = await balanceOf(risky);
  const safeBalance = await balanceOf(safe);

  // Everything the engine sees is per share and in safe units, so deposits and
  // withdrawals do not move the target, and the engine floor is the contract
  // floor: initial and high-water mark come from the vault epoch.
  const supply = Number(risk.supply);
  const priceRiskyInSafe = riskyInBase / safeInBase;
  const initial = Number(risk.epoch.initial) / PRICE_SCALE;
  const hwm = Number(risk.epoch.hwm) / PRICE_SCALE;

  const answer = await askEngine({
    price_risky: priceRiskyInSafe,
    price_safe: 1,
    nav: risk.valueSafe,
    max_nav: Math.max(hwm, risk.valueSafe),
    risky_amount: Number(riskyBalance) / supply,
    safe_amount: Number(safeBalance) / supply,
    initial_capital: initial,
  });

  await prisma.strategyState.upsert({
    where: { vault },
    create: { vault, initialSharePrice: initial, maxSharePrice: answer.newMaxNav, lastLimitOrderPrice: answer.limitOrderPrice },
    update: { initialSharePrice: initial, maxSharePrice: answer.newMaxNav, lastLimitOrderPrice: answer.limitOrderPrice },
  });

  // Drift between the target risky value and the real one, in safe units.
  const navSafe = risk.valueSafe * supply;
  const targetRiskyValue = (answer.percentageAsset1 / 100) * navSafe;
  const actualRiskyValue = Number(riskyBalance) * priceRiskyInSafe;
  const delta = targetRiskyValue - actualRiskyValue;
  const driftPct = navSafe > 0 ? Math.abs(delta) / navSafe : 0;
  const actualRiskyPct = navSafe > 0 ? (actualRiskyValue / navSafe) * 100 : 0;

  const common = {
    targetRiskyPct: answer.percentageAsset1,
    actualRiskyPct,
    detail: `limit order ${answer.limitOrderPrice.toFixed(6)}, ratchet steps ${answer.ratchetSteps}`,
  };

  if (risk.stopped && delta > 0) {
    return hold(vault, "the floor is reached: the strategy has stopped and may only sell", log, common);
  }
  if (driftPct * 10_000 < config.keeper.driftBps) {
    return hold(vault, `drift ${(driftPct * 100).toFixed(2)}% below the threshold`, log, common);
  }

  // Direction: buy the risky leg with the safe asset, or sell it back.
  const buy = delta > 0;
  const tokenIn = buy ? safe : risky;
  const tokenOut = buy ? risky : safe;
  const priceInBaseIn = buy ? safeInBase : riskyInBase;
  const priceInBaseOut = buy ? riskyInBase : safeInBase;

  // amount_in in token_in units: a value in safe units divided by the price of
  // token_in in safe units.
  const priceInInSafe = priceInBaseIn / safeInBase;
  let amountIn = BigInt(Math.floor(Math.abs(delta) / priceInInSafe));
  const maxTrade = BigInt(cfg.max_trade_size);
  if (amountIn > maxTrade) amountIn = maxTrade;
  if (amountIn <= 0n) return hold(vault, "amount rounds to zero", log, common);

  const expectedOut = (Number(amountIn) * priceInBaseIn) / priceInBaseOut;
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
