import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  databaseUrl: req("DATABASE_URL"),
  rpcUrl: process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
  networkPassphrase:
    process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
  vaultId: req("VAULT_CONTRACT_ID"),
  baseAssetId: req("BASE_ASSET_ID"),
  riskyAssetIds: (process.env.RISKY_ASSET_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  reflectorId: process.env.REFLECTOR_CONTRACT_ID ?? "",
  cronIntervalSeconds: Number(process.env.CRON_INTERVAL_SECONDS ?? "30"),
  startLedger: process.env.START_LEDGER ? Number(process.env.START_LEDGER) : undefined,
  port: Number(process.env.PORT ?? "8080"),

  // The keeper proposes trades. The vault checks them again onchain.
  keeper: {
    enabled: (process.env.KEEPER_ENABLED ?? "false").toLowerCase() === "true",
    // Send nothing, only store the decision. Safe default.
    dryRun: (process.env.KEEPER_DRY_RUN ?? "true").toLowerCase() !== "false",
    vaultId: process.env.KEEPER_VAULT_ID ?? req("VAULT_CONTRACT_ID"),
    riskyAssetId: process.env.KEEPER_RISKY_ASSET_ID ?? "",
    routerId: process.env.KEEPER_ROUTER_ID ?? "",
    engineUrl: process.env.STRATEGY_ENGINE_URL ?? "http://localhost:8000",
    engineTimeoutMs: Number(process.env.STRATEGY_ENGINE_TIMEOUT_MS ?? "15000"),
    // Operator key. Never commit it. Without it the keeper stays in dry run.
    operatorSecret: process.env.KEEPER_OPERATOR_SECRET ?? "",
    operatorPublicKey: process.env.KEEPER_OPERATOR_PUBLIC ?? "",
    // Rebalance only when the gap to the target is at least this large.
    driftBps: Number(process.env.KEEPER_DRIFT_BPS ?? "100"),
    // Room under the oracle price for min_amount_out.
    slippageBps: Number(process.env.KEEPER_SLIPPAGE_BPS ?? "50"),
    deadlineSeconds: Number(process.env.KEEPER_DEADLINE_SECONDS ?? "120"),
    confirmTimeoutMs: Number(process.env.KEEPER_CONFIRM_TIMEOUT_MS ?? "60000"),
    feeStroops: process.env.KEEPER_FEE_STROOPS ?? "1000000",
    // Alert when the base allocation is less than this above the floor.
    cushionAlertPct: Number(process.env.KEEPER_CUSHION_ALERT_PCT ?? "0.05"),
  },
};

export type Config = typeof config;
