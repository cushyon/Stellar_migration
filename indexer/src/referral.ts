import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { Keypair } from "@stellar/stellar-sdk";
import { prisma } from "./db.js";
import { config } from "./config.js";
import type { DecodedEvent } from "./decode.js";

/// Referral without a contract change.
///
/// A Soroban transaction cannot carry a memo, so the referral code cannot ride
/// on the deposit itself. Instead the referred wallet signs a plain message
/// (SEP-53) that names the code, the wallet and the vault, and sends it to this
/// API. The signature proves that the wallet asked for the binding, so the
/// record is verifiable by anyone who repeats the check; the deposit that
/// follows is linked to it by its transaction hash.
///
/// The reward comes from the performance fee. The vault pays its fees by
/// minting shares to the fee recipient (`fees` event), which dilutes every
/// holder pro rata. The referee's part of that fee is `minted x referee shares
/// / supply`, and the referrer earns `REFERRAL_REFERRER_SHARE_BPS` of it, in
/// vault shares. The treasury pays the rewards and writes the payout hash.

type Log = { info: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };

/// SEP-53: the signature covers SHA-256 of this prefix plus the message bytes.
const SEP53_PREFIX = "Stellar Signed Message:\n";
/// A claim is refused when its timestamp is further away than this.
const CLAIM_WINDOW_SECONDS = 900;

// No 0/O or 1/I: the code is typed by hand and read on an explorer.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

function randomCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

/// The exact message that a referee signs. It says in plain words what the
/// signature does, because the wallet shows it to the user as it is.
export function claimMessage(vault: string, referee: string, code: string, issuedAt: number): string {
  return [
    "Cushion referral",
    `I was referred by the code ${code}.`,
    `wallet: ${referee}`,
    `vault: ${vault}`,
    `issued: ${issuedAt}`,
  ].join("\n");
}

/// The signer of `message` is `address`. SEP-53 signs the SHA-256 of the
/// prefix plus the message; a wallet that signs the message bytes as they are
/// is accepted too, because both forms prove that the key signed this exact
/// message.
export function verifySignedMessage(address: string, message: string, signatureB64: string): boolean {
  try {
    const key = Keypair.fromPublicKey(address);
    const signature = Buffer.from(signatureB64, "base64");
    const bytes = Buffer.from(message, "utf8");
    const digest = createHash("sha256")
      .update(Buffer.concat([Buffer.from(SEP53_PREFIX, "utf8"), bytes]))
      .digest();
    return key.verify(digest, signature) || key.verify(bytes, signature);
  } catch {
    return false;
  }
}

/// One code per wallet, created on first request. Anyone may create the code
/// of any address: a code only directs rewards to that address.
export async function getOrCreateCode(address: string): Promise<string> {
  const existing = await prisma.referralCode.findUnique({ where: { address } });
  if (existing) return existing.code;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const row = await prisma.referralCode.create({ data: { code: randomCode(), address } });
      return row.code;
    } catch (e: any) {
      if (e?.code !== "P2002") throw e; // code taken, or the address won a race
      const race = await prisma.referralCode.findUnique({ where: { address } });
      if (race) return race.code;
    }
  }
  throw new Error("could not allocate a referral code");
}

export type ClaimResult =
  | { ok: true; referrer: string; alreadyBound: boolean }
  | { ok: false; reason: string };

/// Bind a wallet to a referrer, on the signed request of that wallet.
/// Refused when the signature does not match, when the claim is old, when the
/// code is unknown, when the wallet refers itself, or when the wallet already
/// holds shares of the vault (the referral rewards the first deposit).
export async function claimReferral(
  input: { vault: string; referee: string; code: string; issuedAt: number; signature: string },
  log?: Log
): Promise<ClaimResult> {
  const code = input.code.toUpperCase();
  const bound = await prisma.referral.findUnique({
    where: { vault_referee: { vault: input.vault, referee: input.referee } },
  });
  if (bound) return { ok: true, referrer: bound.referrer, alreadyBound: true };

  const age = Math.abs(Math.floor(Date.now() / 1000) - input.issuedAt);
  if (!Number.isFinite(input.issuedAt) || age > CLAIM_WINDOW_SECONDS) {
    return { ok: false, reason: "the claim is too old; sign it again" };
  }

  const message = claimMessage(input.vault, input.referee, code, input.issuedAt);
  if (!verifySignedMessage(input.referee, message, input.signature)) {
    return { ok: false, reason: "the signature does not match the wallet" };
  }

  const owner = await prisma.referralCode.findUnique({ where: { code } });
  if (!owner) return { ok: false, reason: "unknown referral code" };
  if (owner.address === input.referee) return { ok: false, reason: "a wallet cannot refer itself" };

  const position = await prisma.userPosition.findUnique({
    where: { vault_address: { vault: input.vault, address: input.referee } },
  });
  if (position && BigInt(position.shares.toString()) > 0n) {
    return { ok: false, reason: "the wallet already holds shares of this vault" };
  }

  try {
    await prisma.referral.create({
      data: {
        vault: input.vault,
        referee: input.referee,
        referrer: owner.address,
        code,
        message,
        signature: input.signature,
      },
    });
  } catch (e: any) {
    if (e?.code !== "P2002") throw e; // bound by a parallel claim
    const race = await prisma.referral.findUnique({
      where: { vault_referee: { vault: input.vault, referee: input.referee } },
    });
    return { ok: true, referrer: race?.referrer ?? owner.address, alreadyBound: true };
  }
  log?.info(`[referral] ${input.referee} claims the code ${code} of ${owner.address}`);
  return { ok: true, referrer: owner.address, alreadyBound: false };
}

/// Link the first deposit of a referred wallet to its binding. Runs before the
/// share delta of the event is applied, so a binding without a deposit stays
/// without one until the wallet really deposits. Only a referral with a deposit
/// earns rewards.
export async function attributeDeposit(ev: DecodedEvent, log?: Log): Promise<void> {
  const vault = ev.contractId;
  const receiver = String(ev.topics[2]);
  const referral = await prisma.referral.findUnique({
    where: { vault_referee: { vault, referee: receiver } },
  });
  if (!referral || referral.depositTx) return;
  await prisma.referral.update({
    where: { vault_referee: { vault, referee: receiver } },
    data: { depositTx: ev.txHash, ledger: ev.ledger, ts: ev.ts },
  });
  log?.info(`[referral] first deposit of ${receiver} linked to ${referral.referrer} (tx ${ev.txHash})`);
}

/// Credit the referrers for one `fees` event. Runs before the share delta of
/// the event is applied, so the positions and their sum are the holdings that
/// the fee diluted. Idempotent: one reward row per (fee event, referee).
export async function rewardFeeEvent(ev: DecodedEvent, log?: Log): Promise<void> {
  const vault = ev.contractId;
  const d = ev.data as unknown[];
  const mgmtFee = BigInt(String(d[0]));
  const perfFee = BigInt(String(d[1]));
  const minted = BigInt(String(d[2]));
  if (perfFee <= 0n || minted <= 0n) return;
  // Only the performance part of the minted shares is shared.
  const perfShares = (minted * perfFee) / (mgmtFee + perfFee);

  const referrals = await prisma.referral.findMany({ where: { vault, depositTx: { not: null } } });
  if (referrals.length === 0) return;

  // The share supply that the fee diluted. The snapshot reads `total_supply`
  // from the contract every cycle, so it stays right even when the event
  // history has a hole; the sum of the positions is the fallback.
  const snapshot = await prisma.vaultSnapshot.findFirst({
    where: { contractId: vault, ledger: { lte: ev.ledger } },
    orderBy: { ledger: "desc" },
  });
  let supply = BigInt(snapshot?.totalShares.toString() ?? "0");
  if (supply <= 0n) {
    const agg = await prisma.userPosition.aggregate({ where: { vault }, _sum: { shares: true } });
    supply = BigInt(agg._sum.shares?.toString() ?? "0");
  }
  if (supply <= 0n) return;

  const shareBps = BigInt(config.referral.referrerShareBps);
  for (const r of referrals) {
    const position = await prisma.userPosition.findUnique({
      where: { vault_address: { vault, address: r.referee } },
    });
    const held = position ? BigInt(position.shares.toString()) : 0n;
    if (held <= 0n) continue;
    const refereePart = (perfShares * held) / supply;
    const reward = (refereePart * shareBps) / 10_000n;
    if (reward <= 0n) continue;
    try {
      await prisma.referralReward.create({
        data: {
          vault,
          feeEventId: ev.id,
          referrer: r.referrer,
          referee: r.referee,
          shares: new Prisma.Decimal(reward.toString()),
          ts: ev.ts,
        },
      });
      log?.info(`[referral] ${r.referrer} earns ${reward} shares from the fee of ${r.referee} (event ${ev.id})`);
    } catch (e: any) {
      if (e?.code !== "P2002") throw e; // already credited
    }
  }
}

/// What the API serves for one wallet: its code, who it referred, what it
/// earned, and who referred it. The proof of each binding is included, so a
/// reader can repeat the signature check.
export async function referralSummary(address: string) {
  const code = await prisma.referralCode.findUnique({ where: { address } });
  const referred = await prisma.referral.findMany({ where: { referrer: address }, orderBy: { claimedAt: "desc" } });
  const rewards = await prisma.referralReward.findMany({ where: { referrer: address }, orderBy: { ts: "desc" } });
  const referredBy = await prisma.referral.findFirst({ where: { referee: address } });
  const sum = (status: string) =>
    rewards.filter((r) => r.status === status).reduce((acc, r) => acc + BigInt(r.shares.toString()), 0n);
  return {
    address,
    code: code?.code ?? null,
    referrerShareBps: config.referral.referrerShareBps,
    referred: referred.map((r) => ({
      vault: r.vault,
      referee: r.referee,
      depositTx: r.depositTx,
      claimedAt: r.claimedAt,
      ts: r.ts,
    })),
    rewards: {
      pendingShares: sum("pending").toString(),
      paidShares: sum("paid").toString(),
      rows: rewards.map((r) => ({
        id: r.id,
        vault: r.vault,
        referee: r.referee,
        feeEventId: r.feeEventId,
        shares: r.shares.toString(),
        status: r.status,
        payoutTx: r.payoutTx,
        ts: r.ts,
      })),
    },
    referredBy: referredBy
      ? {
          vault: referredBy.vault,
          referrer: referredBy.referrer,
          code: referredBy.code,
          depositTx: referredBy.depositTx,
          message: referredBy.message,
          signature: referredBy.signature,
        }
      : null,
  };
}
