-- CreateTable
CREATE TABLE "referral_code" (
    "code" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_code_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "referral" (
    "vault" TEXT NOT NULL,
    "referee" TEXT NOT NULL,
    "referrer" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "deposit_tx" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_pkey" PRIMARY KEY ("vault","referee")
);

-- CreateTable
CREATE TABLE "referral_reward" (
    "id" SERIAL NOT NULL,
    "vault" TEXT NOT NULL,
    "fee_event_id" TEXT NOT NULL,
    "referrer" TEXT NOT NULL,
    "referee" TEXT NOT NULL,
    "shares" DECIMAL(40,0) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payout_tx" TEXT,
    "ts" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_reward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_code_address_key" ON "referral_code"("address");

-- CreateIndex
CREATE INDEX "referral_vault_referrer_idx" ON "referral"("vault", "referrer");

-- CreateIndex
CREATE INDEX "referral_reward_vault_referrer_status_idx" ON "referral_reward"("vault", "referrer", "status");

-- CreateIndex
CREATE UNIQUE INDEX "referral_reward_fee_event_id_referee_key" ON "referral_reward"("fee_event_id", "referee");
