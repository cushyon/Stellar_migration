-- AlterTable
ALTER TABLE "risk_snapshot" ADD COLUMN     "epoch_active" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stopped" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "value_pct" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "vault_snapshot" ADD COLUMN     "safe_is_base" BOOLEAN NOT NULL DEFAULT true;
