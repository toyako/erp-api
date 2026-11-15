-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT,
    "phone" TEXT,
    "rating" INTEGER NOT NULL DEFAULT 3,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "order_no" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "sku_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_amount" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_code_key" ON "suppliers"("code");

-- CreateIndex
CREATE INDEX "suppliers_tenant_id_idx" ON "suppliers"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_order_no_key" ON "purchase_orders"("order_no");

-- CreateIndex
CREATE INDEX "purchase_orders_tenant_id_status_idx" ON "purchase_orders"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "purchase_order_lines_order_id_idx" ON "purchase_order_lines"("order_id");
