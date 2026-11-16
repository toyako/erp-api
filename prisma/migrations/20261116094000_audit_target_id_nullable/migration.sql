-- GAP 批回炉：审计 targetId 契约里可为空（取不到响应体 id 时为 null），
-- 但 init 迁移把 audit_events.target_id 建成了 NOT NULL，导致
-- saveAuditEvent 的 string | null 赋值在 CI typecheck 挂掉（TS2322）。
-- 把列放宽为可空，与契约与 toAuditEvent 的 string | null 口径一致。
ALTER TABLE "audit_events" ALTER COLUMN "target_id" DROP NOT NULL;
