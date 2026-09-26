import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { readContract, addressArg } from "./stellar.js";
import { notifyAlerts, type Alert } from "./alerts.js";

export interface RiskPicture {
  nav: bigint;
  supply: bigint;
  sharePrice: number;
  baseBalance: bigint;
  basePct: number;
  floorPct: number;
  cushionPct: number; // base allocation above the floor, in points of NAV
  oracleAgeSec: number | null;
  oracleOk: boolean;
  paused: boolean;
  alerts: Alert[];
}

/// Read the risk picture of a vault: how far the base allocation is from the
/// floor that the contract enforces, whether the oracle answers, and whether the
/// vault is paused. It writes one row per cycle and returns the alerts.
export async function takeRiskSnapshot(
  vault: string,
  log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
  extraAlerts: Alert[] = []
): Promise<RiskPicture> {
  const alerts: Alert[] = [];

  const cfg = (await readContract(vault, "get_config")) as { floor_bps: number; staleness: bigint };
  const paused = (await readContract(vault, "paused")) as boolean;
  const supply = BigInt((await readContract(vault, "total_supply")) as bigint);

  // NAV needs the oracle for every risky leg, so a failure here is an oracle alert.
  let nav = 0n;
  let oracleOk = true;
  try {
    nav = BigInt((await readContract(vault, "total_assets")) as bigint);
  } catch (e) {
    oracleOk = false;
    alerts.push({ key: "oracle", message: `NAV unavailable: ${(e as Error).message}` });
  }

  const baseBalance = BigInt(
    (await readContract(config.baseAssetId, "balance", [addressArg(vault)])) as bigint
  );

  const navNum = Number(nav);
  const basePct = navNum > 0 ? Number(baseBalance) / navNum : 1;
  const floorPct = cfg.floor_bps / 10_000;
  const cushionPct = basePct - floorPct;
  const sharePrice = supply > 0n ? navNum / Number(supply) : 0;

  // Age of the price that the vault would use for a risky leg.
  let oracleAgeSec: number | null = null;
  if (config.riskyAssetIds.length > 0) {
    try {
      await readContract(vault, "safe_price", [addressArg(config.riskyAssetIds[0])]);
    } catch (e) {
      oracleOk = false;
      alerts.push({ key: "oracle", message: `price unavailable: ${(e as Error).message}` });
    }
  }

  if (paused) alerts.push({ key: "paused", message: "the vault is paused" });
  if (oracleOk && cushionPct < config.keeper.cushionAlertPct) {
    alerts.push({
      key: "cushion",
      message: `base allocation ${(basePct * 100).toFixed(1)}% is close to the floor ${(floorPct * 100).toFixed(1)}%`,
    });
  }
  if (supply === 0n) alerts.push({ key: "no_shares", message: "the vault has no shares" });

  await prisma.riskSnapshot.create({
    data: {
      vault,
      nav: new Prisma.Decimal(nav.toString()),
      sharePrice,
      basePct,
      floorPct,
      cushionPct,
      oracleAgeSec,
      oracleOk,
      paused,
      alerts: alerts.map((a) => a.message),
    },
  });

  // The risk alerts of this cycle, plus the ones the caller passed in.
  await notifyAlerts(vault, alerts.concat(extraAlerts), log);

  if (alerts.length > 0) log?.warn(`[risk] ${vault}: ${alerts.map((a) => a.message).join(" | ")}`);
  else log?.info(`[risk] base ${(basePct * 100).toFixed(1)}% floor ${(floorPct * 100).toFixed(1)}% oracle ok`);

  return {
    nav,
    supply,
    sharePrice,
    baseBalance,
    basePct,
    floorPct,
    cushionPct,
    oracleAgeSec,
    oracleOk,
    paused,
    alerts,
  };
}
