import Fastify from "fastify";
import cors from "@fastify/cors";
import cron from "node-cron";
import { config } from "./config.js";
import { registerRoutes } from "./routes.js";
import { ingestOnce } from "./ingest.js";
import { takeSnapshot } from "./snapshot.js";
import { recordReflectorPrices } from "./prices.js";

async function main() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await registerRoutes(app);

  // Single embedded poller — one service, one cron, no separate cron service,
  // no infinite while-loop. Overlapping cycles are skipped.
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await ingestOnce(app.log);
      await takeSnapshot(app.log);
      await recordReflectorPrices("XLM", app.log);
    } catch (e) {
      app.log.error(e, "[poller] cycle failed");
    } finally {
      running = false;
    }
  };

  const sec = Math.max(5, config.cronIntervalSeconds);
  const expr = sec % 60 === 0 ? `*/${sec / 60} * * * *` : `*/${sec} * * * * *`;
  cron.schedule(expr, tick);

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`indexer up on :${config.port}; polling every ${sec}s for ${config.vaultId}`);
  tick(); // immediate first cycle so data is fresh on boot
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
