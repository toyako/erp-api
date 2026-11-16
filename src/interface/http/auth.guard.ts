import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError } from '../../domain/ports';
import { IamService } from '../../application/iam.service';

/**
 * 全局登录鉴权守卫（第 1 批 AUTH）：除 @Public() 路由外，所有接口必须带有效 JWT。
 *
 * - 放行：@Public() 路由（登录、健康检查）、所有 OPTIONS（CORS 预检——
 *   预检不带 Authorization，拦了它 erp.yunzhiwu.xyz 的跨域会直接断）。
 * - 其余路由：Authorization: Bearer 缺失/无效/过期 → 401；复用
 *   IamService.currentUser()（验签 + 查库，主体被删也进不来），主体挂 req.user。
 * - 角色矩阵（principal.roles 数组）：
 *   - 含 admin → 全放行；
 *   - 含 sales（无 admin）→ 禁 /iam/*（403），其余放行；
 *   - 其余（readonly 等）→ 仅 GET，写操作 403。
 * - 统一抛 DomainError，走现有 DomainErrorFilter。
 */
export const PUBLIC_KEY = 'erp:public';
export const Public = () => SetMetadata(PUBLIC_KEY, true);

type GuardRequest = {
  method?: string;
  path?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  user?: { username?: string; roles?: string[] };
};

/** 去掉全局前缀 /api，返回如 '/iam/principals'、'/customers' */
function stripApiPrefix(path: string): string {
  return path.startsWith('/api/') ? path.slice(4) : path === '/api' ? '/' : path;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly iam: IamService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<GuardRequest>();
    if (String(req.method ?? '').toUpperCase() === 'OPTIONS') return true;

    // Authorization 头可能是 string[]（多值头），只取第一个
    const rawAuth = req.headers?.['authorization'];
    const authorization = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
    const principal = await this.iam.currentUser(authorization);
    req.user = { username: principal.username, roles: principal.roles };

    const roles = principal.roles ?? [];
    if (roles.includes('admin')) return true;

    const path = stripApiPrefix(req.path ?? req.url?.split('?')[0] ?? '');
    if (roles.includes('sales')) {
      if (path === '/iam' || path.startsWith('/iam/')) {
        throw new DomainError('FORBIDDEN', '销售角色不可管理用户', 403);
      }
      return true;
    }

    if (String(req.method ?? '').toUpperCase() !== 'GET') {
      throw new DomainError('FORBIDDEN', '只读角色不可写', 403);
    }
    return true;
  }
}
