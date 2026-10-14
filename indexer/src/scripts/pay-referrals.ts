// Pay the pending referral rewards from the treasury, in vault shares.
//
// The vault pays its fees by minting shares to the fee recipient, so the
// treasury already holds the shares that the rewards come from. This script
// sends each referrer its total, with one `transfer` per referrer, and writes
// the payout hash back on every row it paid.
//
// It needs the treasury key in REFERRAL_TREASURY_SECRET (the fee recipient of
// the vault). Without it, the script prints what it would pay and sends nothing.
//
// Usage: npx tsx src/scripts/pay-referrals.ts [vault]
import { Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { addressArg, invokeContract, ContractCallError } from "../stellar.js";

const vault = process.argv[2] ?? config.keeper.vaultId;
const secret = process.env.REFERRAL_TREASURY_SECRET ?? "";
const treasury = secret ? Keypair.fromSecret(secret).publicKey() : "";

const pending = await prisma.referralReward.findMany({ where: { vault, status: "pending" } });
if (pending.length === 0) {
  console.log(`[pay-referrals] nothing pending for ${vault}`);
  process.exit(0);
}

const byReferrer = new Map<string, { total: bigint; ids: number[] }>();
for (const row of pending) {
  const entry = byReferrer.get(row.referrer) ?? { total: 0n, ids: [] };
  entry.total += BigInt(row.shares.toString());
  entry.ids.push(row.id);
  byReferrer.set(row.referrer, entry);
}

console.log(`[pay-referrals] vault ${vault}, ${pending.length} rewards, ${byReferrer.size} referrers`);
for (const [referrer, { total, ids }] of byReferrer) {
  if (!secret) {
    console.log(`[pay-referrals] would pay ${total} shares to ${referrer} (${ids.length} rewards)`);
    continue;
  }
  try {
    const { hash } = await invokeContract(
      vault,
      "transfer",
      [addressArg(treasury), addressArg(referrer), nativeToScVal(total, { type: "i128" })],
      secret
    );
    await prisma.referralReward.updateMany({
      where: { id: { in: ids } },
      data: { status: "paid", payoutTx: hash },
    });
    console.log(`[pay-referrals] paid ${total} shares to ${referrer}, tx ${hash}`);
  } catch (e) {
    const error = e as ContractCallError;
    console.error(`[pay-referrals] payment to ${referrer} failed: ${error.message}`);
  }
}

await prisma.$disconnect();
