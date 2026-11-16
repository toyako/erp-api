-- AlterTable
ALTER TABLE "inventory_lots" ADD COLUMN "location" TEXT NOT NULL DEFAULT '主仓';

-- CreateTable
CREATE TABLE "transfers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "transfer_no" TEXT NOT NULL,
    "sku_id" TEXT NOT NULL,
    "from_location" TEXT NOT NULL,
    "to_location" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "batch_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktakes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "stocktake_no" TEXT NOT NULL,
    "lot_id" TEXT NOT NULL,
    "sku_id" TEXT NOT NULL,
    "counted_qty" INTEGER NOT NULL,
    "system_qty" INTEGER NOT NULL,
    "difference" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "stocktakes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "transfers_transfer_no_key" ON "transfers"("transfer_no");

-- CreateIndex
CREATE INDEX "transfers_tenant_id_status_idx" ON "transfers"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stocktakes_stocktake_no_key" ON "stocktakes"("stocktake_no");

-- CreateIndex
CREATE INDEX "stocktakes_tenant_id_status_idx" ON "stocktakes"("tenant_id", "status");
