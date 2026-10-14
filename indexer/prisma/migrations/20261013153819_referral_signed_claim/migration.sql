/*
  Warnings:

  - Added the required column `message` to the `referral` table without a default value. This is not possible if the table is not empty.
  - Added the required column `signature` to the `referral` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "referral" ADD COLUMN     "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "message" TEXT NOT NULL,
ADD COLUMN     "signature" TEXT NOT NULL,
ALTER COLUMN "deposit_tx" DROP NOT NULL,
ALTER COLUMN "ledger" DROP NOT NULL,
ALTER COLUMN "ts" DROP NOT NULL;
