import type { FastifyInstance } from "fastify";
import {
  vaultStats,
  vaultHistory,
  userPositions,
  userPositionHistory,
} from "./metrics.js";
import { getPriceHistory } from "./prices.js";
import { prisma } from "./db.js";
import { claimMessage, claimReferral, getOrCreateCode, referralSummary } from "./referral.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ ok: true }));

  // TVL, allocation split, performance (latest snapshot).
  app.get("/vaults/:id/stats", async (req, reply) => {
    const { id } = req.params as { id: string };
    const stats = await vaultStats(id);
    if (!stats) return reply.code(404).send({ error: "no snapshot yet" });
    return stats;
  });

  // Snapshot time series. ?range=7d|30d|60d|90d|all
  app.get("/vaults/:id/history", async (req) => {
    const { id } = req.params as { id: string };
    const { range } = req.query as { range?: string };
    return vaultHistory(id, range ?? "30d");
  });

  // Share holdings for an address across vaults.
  app.get("/users/:address/positions", async (req) => {
    const { address } = req.params as { address: string };
    return userPositions(address);
  });

  // Position value time series for one address in one vault. ?range=7d|30d|90d|all
  app.get("/users/:address/vaults/:id/history", async (req) => {
    const { address, id } = req.params as { address: string; id: string };
    const { range } = req.query as { range?: string };
    return userPositionHistory(id, address, range ?? "30d");
  });

  // Risk picture of the last cycles: distance to the floor, oracle, pause state.
  app.get("/vaults/:id/risk", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { limit } = req.query as { limit?: string };
    const rows = await prisma.riskSnapshot.findMany({
      where: { vault: id },
      orderBy: { ts: "desc" },
      take: Math.min(Number(limit ?? "1"), 200),
    });
    if (rows.length === 0) return reply.code(404).send({ error: "no risk snapshot yet" });
    return { latest: rows[0], history: rows };
  });

  // Keeper decisions, newest first: what it proposed and what the vault answered.
  // ?trades=1 leaves out the hold rows: the keeper writes one per cycle, so
  // the trades would otherwise fall out of any recent window within minutes.
  app.get("/vaults/:id/strategy-runs", async (req) => {
    const { id } = req.params as { id: string };
    const { limit, trades } = req.query as { limit?: string; trades?: string };
    return prisma.strategyRun.findMany({
      where: trades === "1" ? { vault: id, action: { not: "hold" } } : { vault: id },
      orderBy: { ts: "desc" },
      take: Math.min(Number(limit ?? "50"), 500),
    });
  });

  // Stored USD price history for a ticker (accumulated from the Reflector
  // oracle each cycle; served from the indexer DB). ?days=7|30|90|…
  app.get("/prices/:symbol", async (req) => {
    const { symbol } = req.params as { symbol: string };
    const { days } = req.query as { days?: string };
    const d = Math.min(Math.max(Number(days ?? "30"), 1), 365);
    return getPriceHistory(symbol.toUpperCase(), d);
  });

  // Referral: the code of a wallet (created on first request), the owner of a
  // code, and the referral picture of a wallet.
  app.get("/referrals/code/:address", async (req) => {
    const { address } = req.params as { address: string };
    return { address, code: await getOrCreateCode(address) };
  });

  app.get("/referrals/:code", async (req, reply) => {
    const { code } = req.params as { code: string };
    const row = await prisma.referralCode.findUnique({ where: { code: code.toUpperCase() } });
    if (!row) return reply.code(404).send({ error: "unknown referral code" });
    return { code: row.code, referrer: row.address };
  });

  // The message that a referee must sign to claim a code. The frontend asks
  // for it, the wallet shows it, and the signature comes back to /claim.
  app.get("/referrals/message", async (req, reply) => {
    const { vault, address, code } = req.query as { vault?: string; address?: string; code?: string };
    if (!vault || !address || !code) {
      return reply.code(400).send({ error: "vault, address and code are required" });
    }
    const issuedAt = Math.floor(Date.now() / 1000);
    return { issuedAt, message: claimMessage(vault, address, code.toUpperCase(), issuedAt) };
  });

  app.post("/referrals/claim", async (req, reply) => {
    const body = req.body as {
      vault?: string;
      address?: string;
      code?: string;
      issuedAt?: number;
      signature?: string;
    };
    if (!body?.vault || !body.address || !body.code || !body.issuedAt || !body.signature) {
      return reply.code(400).send({ error: "vault, address, code, issuedAt and signature are required" });
    }
    const result = await claimReferral(
      {
        vault: body.vault,
        referee: body.address,
        code: body.code,
        issuedAt: Number(body.issuedAt),
        signature: body.signature,
      },
      { info: (m) => app.log.info(m) }
    );
    if (!result.ok) return reply.code(400).send({ error: result.reason });
    return result;
  });

  app.get("/users/:address/referrals", async (req) => {
    const { address } = req.params as { address: string };
    return referralSummary(address);
  });
}
