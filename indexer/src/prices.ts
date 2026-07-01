import { prisma } from "./db.js";
import { config } from "./config.js";
import { reflectorPrices } from "./stellar.js";

const HOUR = 3600;

/// Upsert `{ ts, price }` points into `price_snapshot`, deduped to one row per
/// hour. The storage layer — real Reflector readings and any local backfill
/// both land here, so the DB is the single source of truth for the chart.
export async function upsertPoints(
  symbol: string,
  points: { ts: number; price: number }[]
): Promise<number> {
  for (const p of points) {
    const bucket = Math.floor(p.ts / HOUR);
    await prisma.priceSnapshot.upsert({
      where: { symbol_bucket: { symbol, bucket } },
      create: { symbol, bucket, ts: new Date(p.ts * 1000), priceUsd: p.price },
      update: { ts: new Date(p.ts * 1000), priceUsd: p.price },
    });
  }
  return points.length;
}

/// Accumulate the recent Reflector price window (real onchain oracle data) into
/// the DB. Called each poll cycle; hourly dedup keeps it compact.
export async function recordReflectorPrices(
  symbol: string,
  log?: { info: (m: string) => void }
): Promise<void> {
  if (!config.reflectorId) return;
  const points = await reflectorPrices(config.reflectorId, symbol, 20);
  if (points.length) {
    await upsertPoints(symbol, points);
    log?.info(`[prices] +${points.length} ${symbol} points from Reflector`);
  }
}

/// Stored price history (oldest→newest) within `days`.
export async function getPriceHistory(
  symbol: string,
  days: number
): Promise<{ ts: number; price: number }[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.priceSnapshot.findMany({
    where: { symbol, ts: { gte: since } },
    orderBy: { ts: "asc" },
  });
  return rows.map((r) => ({ ts: Math.floor(r.ts.getTime() / 1000), price: r.priceUsd }));
}
