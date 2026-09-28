import { Prisma } from "@prisma/client";
import { readContract, addressArg, latestLedger } from "./stellar.js";
import { prisma } from "./db.js";
import { config } from "./config.js";

/// Read live vault metrics via RPC and persist a snapshot. NAV comes from the
/// vault's own `total_assets` (the multi-asset chokepoint), so TVL and the
/// allocation split reconcile with the contract by construction.
export async function takeSnapshot(log?: { info: (m: string) => void }): Promise<void> {
  const ledger = await latestLedger();

  const nav = BigInt((await readContract(config.vaultId, "total_assets")) as bigint);
  const totalShares = BigInt((await readContract(config.vaultId, "total_supply")) as bigint);
  const baseBal = BigInt(
    (await readContract(config.baseAssetId, "balance", [addressArg(config.vaultId)])) as bigint
  );
  // Non-base value in base = NAV − base balance (already oracle-valued inside NAV).
  const riskyValue = nav - baseBal > 0n ? nav - baseBal : 0n;
  const sharePrice = totalShares > 0n ? Number(nav) / Number(totalShares) : 0;
  // Which side is the safe leg. In the product shape the base asset is the
  // risky leg and the safe asset is the other token.
  const cfg = (await readContract(config.vaultId, "get_config")) as { safe_asset: string };
  const safeIsBase = cfg.safe_asset === config.baseAssetId;

  await prisma.vaultSnapshot.create({
    data: {
      contractId: config.vaultId,
      ledger,
      nav: new Prisma.Decimal(nav.toString()),
      totalShares: new Prisma.Decimal(totalShares.toString()),
      sharePrice,
      allocBase: new Prisma.Decimal(baseBal.toString()),
      allocRisky: new Prisma.Decimal(riskyValue.toString()),
      safeIsBase,
    },
  });
  log?.info(`[snapshot] nav=${nav} shares=${totalShares} ledger=${ledger}`);
}
