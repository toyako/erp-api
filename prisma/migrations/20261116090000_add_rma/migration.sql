-- CreateTable
CREATE TABLE "rmas" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "rma_no" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "sku_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "refund_amount" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_at" TIMESTAMP(3),

    CONSTRAINT "rmas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rmas_rma_no_key" ON "rmas"("rma_no");

-- CreateIndex
CREATE INDEX "rmas_tenant_id_status_idx" ON "rmas"("tenant_id", "status");
