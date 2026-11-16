-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_tiers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "sku_id" TEXT NOT NULL,
    "channel_code" TEXT NOT NULL,
    "min_qty" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_code_key" ON "categories"("code");
CREATE INDEX "categories_tenant_id_parent_id_idx" ON "categories"("tenant_id", "parent_id");
CREATE UNIQUE INDEX "price_tiers_sku_id_channel_code_min_qty_key" ON "price_tiers"("sku_id", "channel_code", "min_qty");
CREATE INDEX "price_tiers_tenant_id_sku_id_idx" ON "price_tiers"("tenant_id", "sku_id");
CREATE UNIQUE INDEX "warehouses_code_key" ON "warehouses"("code");
CREATE INDEX "warehouses_tenant_id_idx" ON "warehouses"("tenant_id");

-- 种子仓库档案：与现有批次 location 值一致（主仓 / 华东仓）
INSERT INTO "warehouses" ("id", "tenant_id", "code", "name", "enabled") VALUES
  ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000001', '主仓', '主仓', true),
  ('00000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-000000000001', '华东仓', '华东仓', true);

-- 种子分类：根“软件”下挂两个子分类，与现有 SPU 的 categoryCode 对应
INSERT INTO "categories" ("id", "tenant_id", "code", "name", "parent_id", "sort", "enabled") VALUES
  ('00000000-0000-4000-8000-000000000603', '00000000-0000-4000-8000-000000000001', 'SOFTWARE', '软件', NULL, 0, true),
  ('00000000-0000-4000-8000-000000000604', '00000000-0000-4000-8000-000000000001', 'SOFTWARE-STD', '标准套件', '00000000-0000-4000-8000-000000000603', 0, true),
  ('00000000-0000-4000-8000-000000000605', '00000000-0000-4000-8000-000000000001', 'SOFTWARE-PRO', '专业套件', '00000000-0000-4000-8000-000000000603', 1, true);
