-- 审批规则表（v1 只有采购单一种规则类型）
CREATE TABLE "approval_rules" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "doc_type" TEXT NOT NULL,
    "threshold_amount" INTEGER NOT NULL,
    "threshold_currency" TEXT NOT NULL DEFAULT 'CNY',
    "approver_role" TEXT NOT NULL DEFAULT 'admin',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "approval_rules_tenant_id_doc_type_key" ON "approval_rules"("tenant_id", "doc_type");

-- 种子审批规则：采购单 ≥ ¥10,000 需管理员审批
INSERT INTO "approval_rules" ("id", "tenant_id", "doc_type", "threshold_amount", "threshold_currency", "approver_role", "enabled") VALUES
    ('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000001', 'purchase_order', 1000000, 'CNY', 'admin', true);

-- 换货单表
CREATE TABLE "exchanges" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "exchange_no" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "return_sku_id" TEXT NOT NULL,
    "return_qty" INTEGER NOT NULL,
    "exchange_sku_id" TEXT NOT NULL,
    "exchange_qty" INTEGER NOT NULL,
    "diff_amount" INTEGER,
    "diff_currency" TEXT NOT NULL DEFAULT 'CNY',
    "status" TEXT NOT NULL,
    "reject_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_at" TIMESTAMP(3),
    "exchanged_at" TIMESTAMP(3),

    CONSTRAINT "exchanges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "exchanges_exchange_no_key" ON "exchanges"("exchange_no");
CREATE INDEX "exchanges_tenant_id_status_idx" ON "exchanges"("tenant_id", "status");
