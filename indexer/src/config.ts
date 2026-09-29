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

  // Testnet only: play the arbitrage trader on the Soroswap pool, so the pool
  // stays at the oracle price and the vault can keep its mainnet oracle cap.
  poolAlign: {
    enabled: (process.env.TESTNET_POOL_ALIGN ?? "false").toLowerCase() === "true",
    routerId: process.env.SOROSWAP_ROUTER_ID ?? "",
    toleranceBps: Number(process.env.POOL_ALIGN_TOLERANCE_BPS ?? "20"),
    feeBps: Number(process.env.POOL_ALIGN_FEE_BPS ?? "30"),
    slippageBps: Number(process.env.POOL_ALIGN_SLIPPAGE_BPS ?? "200"),
    // Stroops of XLM the operator keeps for transaction fees.
    baseReserveKept: Number(process.env.POOL_ALIGN_BASE_KEPT ?? "500000000"),
    minAmountIn: Number(process.env.POOL_ALIGN_MIN_AMOUNT_IN ?? "10000000"),
    faucetUrl: process.env.SOROSWAP_FAUCET_URL ?? "https://api.soroswap.finance/api/faucet",
  },

  // The keeper proposes trades. The vault checks them again onchain.
  keeper: {
    enabled: (process.env.KEEPER_ENABLED ?? "false").toLowerCase() === "true",
    // Send nothing, only store the decision. Safe default.
    vaultId: process.env.KEEPER_VAULT_ID ?? req("VAULT_CONTRACT_ID"),
    // Only for a vault whose base asset is the safe asset. When the base asset
    // is the risky leg (the product shape), the keeper derives the roles from
    // the vault config and this value is not used.
    riskyAssetId: process.env.KEEPER_RISKY_ASSET_ID ?? "",
    routerId: process.env.KEEPER_ROUTER_ID ?? "",
    engineUrl: process.env.STRATEGY_ENGINE_URL ?? "http://localhost:8000",
    engineTimeoutMs: Number(process.env.STRATEGY_ENGINE_TIMEOUT_MS ?? "15000"),
    // Operator key. Never commit it. Without it the keeper skips its cycle.
    operatorSecret: process.env.KEEPER_OPERATOR_SECRET ?? "",
    operatorPublicKey: process.env.KEEPER_OPERATOR_PUBLIC ?? "",
    // Rebalance only when the gap to the target is at least this large.
    driftBps: Number(process.env.KEEPER_DRIFT_BPS ?? "100"),
    // Room under the oracle price for min_amount_out.
    slippageBps: Number(process.env.KEEPER_SLIPPAGE_BPS ?? "50"),
    deadlineSeconds: Number(process.env.KEEPER_DEADLINE_SECONDS ?? "120"),
    // Wait after a rejection instead of sending the same proposal again.
    rejectBackoffSeconds: Number(process.env.KEEPER_REJECT_BACKOFF_SECONDS ?? "300"),
    // Alert about a sent but unconfirmed trade only while it is this recent.
    unconfirmedAlertHours: Number(process.env.KEEPER_UNCONFIRMED_ALERT_HOURS ?? "24"),
    confirmTimeoutMs: Number(process.env.KEEPER_CONFIRM_TIMEOUT_MS ?? "60000"),
    feeStroops: process.env.KEEPER_FEE_STROOPS ?? "1000000",
    // Alert when the share value is less than this above the floor, in points
    // of the epoch start value (0.05 = 5 points).
    cushionAlertPct: Number(process.env.KEEPER_CUSHION_ALERT_PCT ?? "0.05"),
  },

  // Where the alerts go. Without a channel they stay in the service log.
  alerts: {
    label: process.env.ALERT_LABEL ?? "cushion-testnet",
    telegramBotToken: process.env.ALERT_TELEGRAM_BOT_TOKEN ?? "",
    telegramChatId: process.env.ALERT_TELEGRAM_CHAT_ID ?? "",
    webhookUrl: process.env.ALERT_WEBHOOK_URL ?? "",
    timeoutMs: Number(process.env.ALERT_TIMEOUT_MS ?? "8000"),
    // An alert that stays true is repeated at most this often.
    repeatMinutes: Number(process.env.ALERT_REPEAT_MINUTES ?? "60"),
  },
};

export type Config = typeof config;
