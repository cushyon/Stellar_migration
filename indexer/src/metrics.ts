import { prisma } from "./db.js";

const DAY_MS = 86_400_000;

/// Trailing return over `days`, measured on share price (so deposit/withdraw
/// flows don't masquerade as performance). null if no old-enough snapshot.
async function trailingReturn(
  vaultId: string,
  latestPrice: number,
  latestTs: Date,
  days: number
): Promise<number | null> {
  const since = new Date(latestTs.getTime() - days * DAY_MS);
  const past = await prisma.vaultSnapshot.findFirst({
    where: { contractId: vaultId, ts: { lte: since } },
    orderBy: { ts: "desc" },
  });
  if (!past || past.sharePrice === 0) return null;
  return latestPrice / past.sharePrice - 1;
}

export async function vaultStats(vaultId: string) {
  const latest = await prisma.vaultSnapshot.findFirst({
    where: { contractId: vaultId },
    orderBy: { ts: "desc" },
  });
  if (!latest) return null;

  const navNum = Number(latest.nav);
  const basePct = navNum > 0 ? Number(latest.allocBase) / navNum : 0;
  const r30 = await trailingReturn(vaultId, latest.sharePrice, latest.ts, 30);
  const r60 = await trailingReturn(vaultId, latest.sharePrice, latest.ts, 60);
  const r90 = await trailingReturn(vaultId, latest.sharePrice, latest.ts, 90);
  const apy = r30 !== null ? Math.pow(1 + r30, 365 / 30) - 1 : null;

  // Return since inception: measured against the first non-zero-price snapshot,
  // so a fresh vault reads 0 rather than null (the trailing windows have no
  // old-enough point yet).
  const first = await prisma.vaultSnapshot.findFirst({
    where: { contractId: vaultId, sharePrice: { gt: 0 } },
    orderBy: { ts: "asc" },
  });
  const inception =
    first && first.sharePrice > 0 ? latest.sharePrice / first.sharePrice - 1 : null;

  return {
    vaultId,
    tvl: latest.nav.toString(), // TVL = NAV, in base units
    sharePrice: latest.sharePrice,
    allocation: {
      base: latest.allocBase.toString(),
      risky: latest.allocRisky.toString(),
      basePct,
      riskyPct: 1 - basePct,
    },
    performance: { "30d": r30, "60d": r60, "90d": r90, apy, inception },
    ledger: latest.ledger,
    ts: latest.ts,
  };
}

export async function vaultHistory(vaultId: string, range: string) {
  const days = ({ "7d": 7, "30d": 30, "60d": 60, "90d": 90, all: 36500 } as const)[
    range as "7d"
  ] ?? 30;
  const since = new Date(Date.now() - days * DAY_MS);
  const rows = await prisma.vaultSnapshot.findMany({
    where: { contractId: vaultId, ts: { gte: since } },
    orderBy: { ts: "asc" },
  });
  return rows.map((r) => ({
    ts: r.ts,
    ledger: r.ledger,
    nav: r.nav.toString(),
    totalShares: r.totalShares.toString(),
    sharePrice: r.sharePrice,
    allocBase: r.allocBase.toString(),
    allocRisky: r.allocRisky.toString(),
  }));
}

/// Position value over time: shares held at each snapshot × that snapshot's
/// share price (base units). The share timeline is rebuilt from the indexed
/// share-moving events (deposit/withdraw/transfer/burn), in TOID order.
export async function userPositionHistory(
  vaultId: string,
  address: string,
  range: string
) {
  const snaps = await vaultHistory(vaultId, range);
  if (snaps.length === 0) return [];

  const events = await prisma.stellarEvent.findMany({
    where: {
      contractId: vaultId,
      type: { in: ["deposit", "withdraw", "transfer", "burn"] },
    },
    orderBy: { id: "asc" },
    select: { type: true, ts: true, topic: true, data: true },
  });

  // shares delta per event for this address (deposit/withdraw carry
  // [assets, shares]; transfer/burn carry the share amount alone)
  const deltas: { at: number; d: bigint }[] = [];
  for (const ev of events) {
    const topic = ev.topic as string[];
    const raw = ev.data as unknown;
    const arr = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
    const at = ev.ts.getTime();
    if (ev.type === "deposit" && topic[2] === address) {
      deltas.push({ at, d: BigInt(arr[1] ?? "0") });
    } else if (ev.type === "withdraw" && topic[1] === address) {
      deltas.push({ at, d: -BigInt(arr[1] ?? "0") });
    } else if (ev.type === "transfer") {
      const amt = BigInt(arr[0] ?? "0");
      if (topic[1] === address) deltas.push({ at, d: -amt });
      if (topic[2] === address) deltas.push({ at, d: amt });
    } else if (ev.type === "burn" && topic[1] === address) {
      deltas.push({ at, d: -BigInt(arr[0] ?? "0") });
    }
  }

  let i = 0;
  let shares = BigInt(0);
  return snaps.map((s) => {
    const at = new Date(s.ts).getTime();
    while (i < deltas.length && deltas[i].at <= at) {
      shares += deltas[i].d;
      i++;
    }
    return { ts: s.ts, value: Number(shares) * s.sharePrice };
  });
}

export async function userPositions(address: string) {
  const rows = await prisma.userPosition.findMany({ where: { address } });
  return Promise.all(
    rows.map(async (r) => {
      // Cost basis = net assets contributed, from the indexed events:
      // deposits credit the share receiver (topic[2]), withdrawals debit the
      // owner (topic[1]). Share transfers between wallets are not attributed
      // (out of scope for now).
      const events = await prisma.stellarEvent.findMany({
        where: { contractId: r.vault, type: { in: ["deposit", "withdraw"] } },
        select: { type: true, topic: true, data: true },
      });
      let deposited = BigInt(0);
      for (const ev of events) {
        const topic = ev.topic as string[];
        const data = ev.data as string[];
        const assets = BigInt(data[0] ?? "0");
        if (ev.type === "deposit" && topic[2] === address) deposited += assets;
        if (ev.type === "withdraw" && topic[1] === address) deposited -= assets;
      }
      return {
        vault: r.vault,
        address: r.address,
        shares: r.shares.toString(),
        deposited: deposited.toString(), // net contributed, base units
        updatedAt: r.updatedAt,
      };
    })
  );
}
