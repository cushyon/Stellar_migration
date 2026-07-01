import type { FastifyInstance } from "fastify";
import { vaultStats, vaultHistory, userPositions } from "./metrics.js";
import { getPriceHistory } from "./prices.js";

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

  // Stored USD price history for a ticker (accumulated from the Reflector
  // oracle each cycle; served from the indexer DB). ?days=7|30|90|…
  app.get("/prices/:symbol", async (req) => {
    const { symbol } = req.params as { symbol: string };
    const { days } = req.query as { days?: string };
    const d = Math.min(Math.max(Number(days ?? "30"), 1), 365);
    return getPriceHistory(symbol.toUpperCase(), d);
  });
}
