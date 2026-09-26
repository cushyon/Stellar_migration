// Run one keeper cycle and print what it decided. Useful to try a change
// without waiting for the poller. The keeper obeys KEEPER_DRY_RUN.
import { runKeeper } from "../keeper.js";
import { prisma } from "../db.js";
import { config } from "../config.js";

const log = { info: console.log, warn: console.warn, error: console.error };
console.log(
  `[keeper-once] vault=${config.keeper.vaultId} enabled=${config.keeper.enabled} dryRun=${config.keeper.dryRun}`
);

await runKeeper(log);

const runs = await prisma.strategyRun.findMany({
  where: { vault: config.keeper.vaultId },
  orderBy: { ts: "desc" },
  take: 3,
});
console.log("last runs:", JSON.stringify(runs, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

const risk = await prisma.riskSnapshot.findFirst({
  where: { vault: config.keeper.vaultId },
  orderBy: { ts: "desc" },
});
console.log("risk:", JSON.stringify(risk, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

await prisma.$disconnect();
process.exit(0);
