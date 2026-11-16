-- 客户余额字段（预存款，充值/余额支付改动）
ALTER TABLE "customers" ADD COLUMN "balance_amount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "customers" ADD COLUMN "balance_currency" TEXT NOT NULL DEFAULT 'CNY';

-- CreateTable
CREATE TABLE "level_rules" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "min_spent_amount" INTEGER NOT NULL,
    "min_spent_currency" TEXT NOT NULL DEFAULT 'CNY',

    CONSTRAINT "level_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "level_rules_tenant_id_level_key" ON "level_rules"("tenant_id", "level");

-- 种子等级规则：普通 ¥0 / VIP ¥1000（累计消费口径与 totalSpent 一致）
INSERT INTO "level_rules" ("id", "tenant_id", "level", "min_spent_amount", "min_spent_currency") VALUES
    ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000001', 'regular', 0, 'CNY'),
    ('00000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-000000000001', 'vip', 100000, 'CNY');

-- CreateTable
CREATE TABLE "customer_followups" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "next_at" TIMESTAMP(3),
    "done" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_followups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_followups_customer_id_idx" ON "customer_followups"("customer_id");

-- CreateTable
CREATE TABLE "customer_balance_txs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "amount_currency" TEXT NOT NULL DEFAULT 'CNY',
    "balance_after" INTEGER NOT NULL,
    "balance_after_currency" TEXT NOT NULL DEFAULT 'CNY',
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_balance_txs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_balance_txs_customer_id_idx" ON "customer_balance_txs"("customer_id");
