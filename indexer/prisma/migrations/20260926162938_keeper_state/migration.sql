-- CreateTable
CREATE TABLE "strategy_state" (
    "vault" TEXT NOT NULL,
    "initial_share_price" DOUBLE PRECISION NOT NULL,
    "max_share_price" DOUBLE PRECISION NOT NULL,
    "last_limit_order_price" DOUBLE PRECISION,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "strategy_state_pkey" PRIMARY KEY ("vault")
);

-- CreateTable
CREATE TABLE "strategy_run" (
    "id" SERIAL NOT NULL,
    "vault" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "target_risky_pct" DOUBLE PRECISION,
    "actual_risky_pct" DOUBLE PRECISION,
    "amount_in" DECIMAL(40,0),
    "min_out" DECIMAL(40,0),
    "nonce" INTEGER,
    "tx_hash" TEXT,
    "error_code" INTEGER,
    "detail" TEXT,

    CONSTRAINT "strategy_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_snapshot" (
    "id" SERIAL NOT NULL,
    "vault" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nav" DECIMAL(40,0) NOT NULL,
    "share_price" DOUBLE PRECISION NOT NULL,
    "base_pct" DOUBLE PRECISION NOT NULL,
    "floor_pct" DOUBLE PRECISION NOT NULL,
    "cushion_pct" DOUBLE PRECISION NOT NULL,
    "oracle_age_sec" INTEGER,
    "oracle_ok" BOOLEAN NOT NULL,
    "paused" BOOLEAN NOT NULL,
    "alerts" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "risk_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "strategy_run_vault_ts_idx" ON "strategy_run"("vault", "ts");

-- CreateIndex
CREATE INDEX "risk_snapshot_vault_ts_idx" ON "risk_snapshot"("vault", "ts");
