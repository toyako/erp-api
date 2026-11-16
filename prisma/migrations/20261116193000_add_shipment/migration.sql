-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "shipment_no" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "order_no" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "carrier" TEXT,
    "tracking_no" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shipped_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipments_shipment_no_key" ON "shipments"("shipment_no");

-- CreateIndex
CREATE INDEX "shipments_tenant_id_status_idx" ON "shipments"("tenant_id", "status");

-- CreateTable
CREATE TABLE "shipment_lines" (
    "id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "sku_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "batch_code" TEXT,

    CONSTRAINT "shipment_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipment_lines_shipment_id_idx" ON "shipment_lines"("shipment_id");
