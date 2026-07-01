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
};

export type Config = typeof config;
