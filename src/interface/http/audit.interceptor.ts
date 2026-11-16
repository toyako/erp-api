import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable, tap } from 'rxjs';
import { DatabasePort } from '../../domain/ports';
import { TENANT_ID } from '../../application/sales.service';

/**
 * 操作审计拦截器（GAP 批第 5 项）：横切所有写接口（POST/PATCH/DELETE），
 * 请求成功后记一条 AuditEvent；不改各业务 service，不接真实鉴权。
 *
 * - 只记写请求：GET 不记；失败（抛错）不记。
 * - 跳过 /auth/*：登录请求体含密码，登录前 actor 也无意义。
 * - actor 未接鉴权时取 'admin'，请求头 x-actor 有值则取之。
 * - action 为 `METHOD + path`（去掉全局前缀 /api），如 'POST /customers'。
 * - targetType 从 path 首段推导：purchase/orders → 'purchase-orders'、
 *   sales/orders → 'sales-orders'，其余取首段。
 * - targetId 优先取响应体的业务单号（rmaNo / transferNo / stocktakeNo /
 *   orderNo / code），取不到时取 id，再取不到为 null——操作日志的
 *   “单据号”列直接显示它，不应显示内部 UUID。
 * - targetId 从响应体 id 取；detail 为请求体摘要（JSON 字符串，截断 500 字，
 *   password 类字段递归脱敏为 ***）。
 * - 写审计失败不得影响主响应：fire-and-forget + catch 吞错。
 */
const WRITE_METHODS = new Set(['POST', 'PATCH', 'DELETE']);
const SENSITIVE_KEYS = new Set(['password', 'passwordhash', 'oldpassword', 'newpassword']);

type AuditRequest = {
  method?: string;
  path?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '***' : redact(item);
    }
    return out;
  }
  return value;
}

/** 去掉全局前缀 /api，返回如 '/customers'、'/sales/orders' */
function stripApiPrefix(path: string): string {
  return path.startsWith('/api/') ? path.slice(4) : path === '/api' ? '/' : path;
}

function entityOf(path: string): string {
  const seg = stripApiPrefix(path).split('/').filter(Boolean);
  if (seg[0] === 'purchase' && seg[1] === 'orders') return 'purchase-orders';
  if (seg[0] === 'sales' && seg[1] === 'orders') return 'sales-orders';
  return seg[0] ?? 'unknown';
}

/** 业务单号：响应体里的 rmaNo / transferNo / stocktakeNo / orderNo / code，取不到时退回 id */
function docNoOf(data: unknown): string | null {
  if (data && typeof data === 'object') {
    const body = data as Record<string, unknown>;
    for (const key of ['rmaNo', 'transferNo', 'stocktakeNo', 'orderNo', 'code']) {
      if (typeof body[key] === 'string' && (body[key] as string).trim()) return body[key] as string;
    }
    if (typeof body.id === 'string' && (body.id as string).trim()) return body.id as string;
  }
  return null;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly db: DatabasePort) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuditRequest>();
    const method = String(req.method ?? '').toUpperCase();
    if (!WRITE_METHODS.has(method)) return next.handle();
    const rawPath = req.path ?? req.url?.split('?')[0] ?? '';
    const path = stripApiPrefix(rawPath);
    if (path.startsWith('/auth/') || path === '/auth') return next.handle();
    return next.handle().pipe(
      tap({
        next: (data: unknown) => {
          void this.write(req, method, path, data).catch(() => undefined);
        },
      }),
    );
  }

  private async write(req: AuditRequest, method: string, path: string, data: unknown): Promise<void> {
    const headerActor = req.headers?.['x-actor'];
    const actor = typeof headerActor === 'string' && headerActor.trim() ? headerActor.trim() : 'admin';
    const detail = JSON.stringify(redact(req.body ?? {})).slice(0, 500);
    const entityId = docNoOf(data);
    await this.db.saveAuditEvent({
      id: randomUUID(),
      tenantId: TENANT_ID,
      actorId: actor,
      action: `${method} ${path}`,
      targetType: entityOf(path),
      targetId: entityId,
      payload: { detail },
      createdAt: new Date().toISOString(),
    });
  }
}
