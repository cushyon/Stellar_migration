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

export async function userPositions(address: string) {
  const rows = await prisma.userPosition.findMany({ where: { address } });
  return rows.map((r) => ({
    vault: r.vault,
    address: r.address,
    shares: r.shares.toString(),
    updatedAt: r.updatedAt,
  }));
}
