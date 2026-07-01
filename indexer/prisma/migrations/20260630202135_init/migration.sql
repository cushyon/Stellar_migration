-- CreateTable
CREATE TABLE "stellar_event" (
    "id" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "contract_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "topic" JSONB NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stellar_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_snapshot" (
    "id" SERIAL NOT NULL,
    "contract_id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ledger" INTEGER NOT NULL,
    "nav" DECIMAL(40,0) NOT NULL,
    "total_shares" DECIMAL(40,0) NOT NULL,
    "share_price" DOUBLE PRECISION NOT NULL,
    "alloc_base" DECIMAL(40,0) NOT NULL,
    "alloc_risky" DECIMAL(40,0) NOT NULL,

    CONSTRAINT "vault_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_position" (
    "vault" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "shares" DECIMAL(40,0) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_position_pkey" PRIMARY KEY ("vault","address")
);

-- CreateTable
CREATE TABLE "IngestState" (
    "contract_id" TEXT NOT NULL,
    "last_ledger" INTEGER NOT NULL,

    CONSTRAINT "IngestState_pkey" PRIMARY KEY ("contract_id")
);

-- CreateIndex
CREATE INDEX "stellar_event_contract_id_ledger_idx" ON "stellar_event"("contract_id", "ledger");

-- CreateIndex
CREATE INDEX "stellar_event_contract_id_type_ledger_idx" ON "stellar_event"("contract_id", "type", "ledger");

-- CreateIndex
CREATE INDEX "vault_snapshot_contract_id_ts_idx" ON "vault_snapshot"("contract_id", "ts");
