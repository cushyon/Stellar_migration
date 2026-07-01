import { ingestOnce } from "../ingest.js";
import { takeSnapshot } from "../snapshot.js";
import { prisma } from "../db.js";

const n = await ingestOnce({ info: console.log, error: console.error });
console.log("inserted this run:", n);
await takeSnapshot({ info: console.log });

const total = await prisma.stellarEvent.count();
const byType = await prisma.stellarEvent.groupBy({ by: ["type"], _count: true });
console.log("total events:", total, "byType:", JSON.stringify(byType));
const positions = await prisma.userPosition.findMany();
console.log("positions:", JSON.stringify(positions.map((p) => ({ a: p.address.slice(0, 6), shares: p.shares.toString() }))));
await prisma.$disconnect();
process.exit(0);
