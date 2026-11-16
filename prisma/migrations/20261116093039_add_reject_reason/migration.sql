-- GAP 批：退货单与调拨单加拒绝原因列（nullable，旧数据为 NULL）
ALTER TABLE "rmas" ADD COLUMN "reject_reason" TEXT;
ALTER TABLE "transfers" ADD COLUMN "reject_reason" TEXT;
