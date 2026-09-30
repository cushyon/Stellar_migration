import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { readContract, addressArg, readWithSupply } from "./stellar.js";
import { notifyAlerts, type Alert } from "./alerts.js";

const PRICE_SCALE = 1e14; // the vault returns prices and share values with 14 decimals

/// Vault config fields the risk module and the keeper read.
export interface VaultConfig {
  safe_asset: string;
  floor_bps: number;
  lockin_bps: number;
  max_trade_size: bigint;
  cooldown_period: bigint;
  staleness: bigint;
}

export interface EpochState {
  initial: bigint;
  hwm: bigint;
  floor: bigint;
  active: boolean;
}

export interface RiskPicture {
  nav: bigint;
  supply: bigint;
  sharePrice: number;
  baseBalance: bigint;
  basePct: number; // share of the NAV held in the base asset
  safeAsset: string;
  safeIsBase: boolean;
  epoch: EpochState;
  /// Share value in the safe asset, per share, unscaled (share_value_safe / 1e14).
  valueSafe: number;
  floorPct: number; // floor / epoch start value
  valuePct: number; // value / epoch start value
  cushionPct: number; // (value - floor) / epoch start value
  stopped: boolean;
  oracleOk: boolean;
  paused: boolean;
  alerts: Alert[];
}

/// Read the risk picture of a vault: where the share value stands against the
/// floor that the contract enforces, whether the oracle answers, and whether the
/// vault is paused. It writes one row per cycle and returns the alerts.
export async function takeRiskSnapshot(
  vault: string,
  log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
  extraAlerts: Alert[] = []
): Promise<RiskPicture> {
  const alerts: Alert[] = [];

  const cfg = (await readContract(vault, "get_config")) as VaultConfig;
  const paused = (await readContract(vault, "paused")) as boolean;
  const epoch = (await readContract(vault, "get_epoch")) as EpochState;
  const safeIsBase = cfg.safe_asset === config.baseAssetId;

  // NAV and the share value need the oracle for every non-base leg, so a
  // failure there is an oracle alert. The reads run between two reads of the
  // supply, so NAV, balance and supply describe the same moment.
  let nav = 0n;
  let valueScaled = 0n;
  let oracleOk = true;
  const { supply, value: read } = await readWithSupply(vault, async () => {
    let navRead = 0n;
    let valueRead = 0n;
    let ok = true;
    try {
      navRead = BigInt((await readContract(vault, "total_assets")) as bigint);
      valueRead = BigInt((await readContract(vault, "share_value_safe")) as bigint);
    } catch (e) {
      ok = false;
      alerts.push({ key: "oracle", message: `share value unavailable: ${(e as Error).message}` });
    }
    const baseBalance = BigInt(
      (await readContract(config.baseAssetId, "balance", [addressArg(vault)])) as bigint
    );
    return { navRead, valueRead, ok, baseBalance };
  });
  nav = read.navRead;
  valueScaled = read.valueRead;
  oracleOk = read.ok;
  const baseBalance = read.baseBalance;

  const navNum = Number(nav);
  const basePct = navNum > 0 ? Number(baseBalance) / navNum : 1;
  const sharePrice = supply > 0n ? navNum / Number(supply) : 0;

  const valueSafe = Number(valueScaled) / PRICE_SCALE;
  const initial = Number(epoch.initial) / PRICE_SCALE;
  const floor = Number(epoch.floor) / PRICE_SCALE;
  const floorPct = initial > 0 ? floor / initial : 0;
  const valuePct = initial > 0 && oracleOk ? valueSafe / initial : 0;
  const cushionPct = initial > 0 && oracleOk ? (valueSafe - floor) / initial : 0;
  const stopped = epoch.active && oracleOk && valueSafe <= floor && supply > 0n;

  if (paused) alerts.push({ key: "paused", message: "the vault is paused" });
  if (supply === 0n) alerts.push({ key: "no_shares", message: "the vault has no shares" });
  if (!epoch.active && supply > 0n) {
    alerts.push({ key: "epoch_not_started", message: "no epoch is active, the strategy cannot trade" });
  }
  if (stopped) {
    alerts.push({
      key: "floor_reached",
      message: `share value ${(valuePct * 100).toFixed(1)}% of start is at or under the floor ${(floorPct * 100).toFixed(1)}%: the strategy has stopped`,
    });
  } else if (epoch.active && oracleOk && supply > 0n && cushionPct < config.keeper.cushionAlertPct) {
    alerts.push({
      key: "cushion",
      message: `share value ${(valuePct * 100).toFixed(1)}% of start is close to the floor ${(floorPct * 100).toFixed(1)}%`,
    });
  }

  await prisma.riskSnapshot.create({
    data: {
      vault,
      nav: new Prisma.Decimal(nav.toString()),
      sharePrice,
      basePct,
      floorPct,
      cushionPct,
      valuePct,
      epochActive: epoch.active,
      stopped,
      oracleAgeSec: null,
      oracleOk,
      paused,
      alerts: alerts.map((a) => a.message),
    },
  });

  // The risk alerts of this cycle, plus the ones the caller passed in.
  await notifyAlerts(vault, alerts.concat(extraAlerts), log);

  if (alerts.length > 0) log?.warn(`[risk] ${vault}: ${alerts.map((a) => a.message).join(" | ")}`);
  else {
    log?.info(
      `[risk] value ${(valuePct * 100).toFixed(1)}% of start, floor ${(floorPct * 100).toFixed(1)}%, ` +
        `base ${(basePct * 100).toFixed(1)}% of NAV, oracle ok`
    );
  }

  return {
    nav,
    supply,
    sharePrice,
    baseBalance,
    basePct,
    safeAsset: cfg.safe_asset,
    safeIsBase,
    epoch,
    valueSafe,
    floorPct,
    valuePct,
    cushionPct,
    stopped,
    oracleOk,
    paused,
    alerts,
  };
}
