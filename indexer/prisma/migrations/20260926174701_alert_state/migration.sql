-- CreateTable
CREATE TABLE "alert_state" (
    "id" TEXT NOT NULL,
    "vault" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_sent_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "alert_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_state_vault_active_idx" ON "alert_state"("vault", "active");
