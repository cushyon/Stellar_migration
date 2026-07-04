import { Prisma } from "@prisma/client";
import { server, latestLedger } from "./stellar.js";
import { prisma, jsonSafe } from "./db.js";
import { config } from "./config.js";
import { decodeEvent, shareDeltas, type DecodedEvent } from "./decode.js";

const LEDGERS_PER_DAY = 17280; // ~5s ledgers
// Cold-start lookback. RPC getEvents retains ~7 days, but the queryable window
// is bounded, so we start ~1 day back (captures recent activity safely within
// retention). Older history would need the archive `getLedgers` path - a
// documented follow-up, not needed now.
const COLD_START_LOOKBACK = LEDGERS_PER_DAY;

async function startLedgerFor(latest: number): Promise<number> {
  const state = await prisma.ingestState.findUnique({
    where: { contractId: config.vaultId },
  });
  if (state) return state.lastLedger + 1;
  if (config.startLedger) return config.startLedger;
  return Math.max(1, latest - COLD_START_LOOKBACK);
}

/// One ingest cycle: scan from the last-ingested ledger, dedup on event id
/// (TOID) via a unique insert, and maintain user_position. Returns the count of
/// newly-inserted events. Idempotent: re-running ingests zero duplicates.
export async function ingestOnce(log?: {
  info: (m: string) => void;
  error: (m: string) => void;
}): Promise<number> {
  const latest = await latestLedger();
  const start = await startLedgerFor(latest);
  if (start > latest) return 0;

  let inserted = 0;
  let scannedTo = start - 1;
  let cursor: string | undefined;

  // getEvents returns a `cursor` on EVERY page - including empty ones - that
  // advances through the ledger range a window at a time. Paginate on the
  // cursor until it stops advancing (caught up to latest); do NOT stop just
  // because a page has < limit events (early pages are often empty).
  for (let page = 0; page < 500; page++) {
    const filters = [{ type: "contract" as const, contractIds: [config.vaultId] }];
    const res: any = cursor
      ? await server.getEvents({ cursor, filters, limit: 100 })
      : await server.getEvents({ startLedger: start, filters, limit: 100 });

    for (const raw of res.events) {
      const ev = decodeEvent(raw);
      if (await persist(ev)) inserted++;
      scannedTo = Math.max(scannedTo, ev.ledger);
    }
    scannedTo = Math.max(scannedTo, res.latestLedger ?? scannedTo);

    const next: string | undefined = res.cursor;
    if (!next || next === cursor) break; // cursor no longer advances → caught up
    cursor = next;
  }

  await prisma.ingestState.upsert({
    where: { contractId: config.vaultId },
    create: { contractId: config.vaultId, lastLedger: scannedTo },
    update: { lastLedger: scannedTo },
  });
  if (inserted) log?.info(`[ingest] +${inserted} events, ledger → ${scannedTo}`);
  return inserted;
}

async function persist(ev: DecodedEvent): Promise<boolean> {
  try {
    await prisma.stellarEvent.create({
      data: {
        id: ev.id,
        ledger: ev.ledger,
        ts: ev.ts,
        contractId: ev.contractId,
        type: ev.type,
        topic: jsonSafe(ev.topics) as Prisma.InputJsonValue,
        data: jsonSafe(ev.data) as Prisma.InputJsonValue,
      },
    });
  } catch (e: any) {
    if (e?.code === "P2002") return false; // duplicate TOID - already ingested
    throw e;
  }

  // Position deltas applied only for newly-inserted events → idempotent.
  for (const d of shareDeltas(ev)) {
    const amount = new Prisma.Decimal(d.delta.toString());
    await prisma.userPosition.upsert({
      where: { vault_address: { vault: d.vault, address: d.address } },
      create: { vault: d.vault, address: d.address, shares: amount },
      update: { shares: { increment: amount } },
    });
  }
  return true;
}
