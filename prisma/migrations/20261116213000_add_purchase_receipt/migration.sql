-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN "reject_reason" TEXT;
ALTER TABLE "purchase_order_lines" ADD COLUMN "received_qty" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "purchase_receipts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "receipt_no" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "order_no" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_receipt_lines" (
    "id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "sku_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "batch_code" TEXT NOT NULL,

    CONSTRAINT "purchase_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipts_receipt_no_key" ON "purchase_receipts"("receipt_no");
CREATE INDEX "purchase_receipts_tenant_id_purchase_order_id_idx" ON "purchase_receipts"("tenant_id", "purchase_order_id");
CREATE INDEX "purchase_receipt_lines_receipt_id_idx" ON "purchase_receipt_lines"("receipt_id");
