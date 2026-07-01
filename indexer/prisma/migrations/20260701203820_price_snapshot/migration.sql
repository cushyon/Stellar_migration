-- CreateTable
CREATE TABLE "price_snapshot" (
    "symbol" TEXT NOT NULL,
    "bucket" INTEGER NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "price_usd" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "price_snapshot_pkey" PRIMARY KEY ("symbol","bucket")
);

-- CreateIndex
CREATE INDEX "price_snapshot_symbol_ts_idx" ON "price_snapshot"("symbol", "ts");
