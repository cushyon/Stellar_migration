// Run the testnet pool alignment once and print the pool against the feed.
// It obeys TESTNET_POOL_ALIGN and refuses to run outside the testnet.
import { alignPool } from "../poolAlign.js";
import { config } from "../config.js";

const log = { info: console.log, warn: console.warn, error: console.error };
console.log(`[align-pool-once] vault=${config.keeper.vaultId} enabled=${config.poolAlign.enabled} router=${config.poolAlign.routerId}`);
await alignPool(log);
process.exit(0);
