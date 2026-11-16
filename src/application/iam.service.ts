import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  LoginRequestSchema,
  type CreatePrincipalRequest,
  type LoginResponse,
  type PageQueryParams,
  type Principal,
  type UpdatePrincipalRequest,
} from '@erp/contracts';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { DatabasePort, DomainError } from '../domain/ports';
import { TENANT_ID } from './sales.service';

const TOKEN_TTL_SECONDS = 3600;

/** 生产必须显式配置；缺失时启动即失败，避免用默认密钥签出可伪造的令牌 */
function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET 必须配置');
    }
    return 'dev-only-insecure-secret';
  }
  return secret;
}

interface TokenPayload {
  sub: string;
  username: string;
  roles: string[];
}

@Injectable()
export class IamService {
  constructor(private readonly db: DatabasePort) {}

  async login(input: unknown): Promise<LoginResponse> {
    const parsed = LoginRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new DomainError('FORBIDDEN', '用户名或密码格式不正确', 400);
    }

    const { username, password } = parsed.data;
    const principal = await this.db.findPrincipalByUsername(username);
    const stored = await this.db.findPasswordHash(username);
    if (!principal || !stored) {
      throw new DomainError('FORBIDDEN', '用户名或密码错误', 401);
    }

    // Prisma 适配器存 bcrypt hash；内存演示适配器存明文
    const matched = stored.startsWith('$2')
      ? await bcrypt.compare(password, stored)
      : stored === password;
    if (!matched) {
      throw new DomainError('FORBIDDEN', '用户名或密码错误', 401);
    }

    const accessToken = jwt.sign(
      { sub: principal.id, username: principal.username, roles: principal.roles },
      jwtSecret(),
      { expiresIn: TOKEN_TTL_SECONDS },
    );

    return { accessToken, expiresIn: TOKEN_TTL_SECONDS, principal };
  }

  /** 从 Authorization: Bearer 解析主体，供 /users/me 使用 */
  async currentUser(authorization?: string): Promise<Principal> {
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined;
    if (!token) throw new DomainError('UNAUTHORIZED', '缺少访问令牌', 401);

    let payload: TokenPayload;
    try {
      payload = jwt.verify(token, jwtSecret()) as TokenPayload;
    } catch {
      throw new DomainError('UNAUTHORIZED', '访问令牌无效或已过期', 401);
    }

    const principal = await this.db.findPrincipalByUsername(payload.username);
    if (!principal) throw new DomainError('UNAUTHORIZED', '主体不存在', 401);
    return principal;
  }

  listPrincipals(params: PageQueryParams) {
    return this.db.listPrincipals(params);
  }

  async createPrincipal(input: CreatePrincipalRequest): Promise<Principal> {
    const existing = await this.db.findPrincipalByUsername(input.username);
    if (existing) throw new DomainError('CONFLICT', `用户名 ${input.username} 已存在`, 409);
    const principal: Principal = {
      id: randomUUID(),
      tenantId: TENANT_ID,
      username: input.username,
      displayName: input.displayName,
      roles: input.roles,
    };
    const passwordHash = await bcrypt.hash(input.password, 10);
    await this.db.savePrincipal(principal, passwordHash);
    return principal;
  }

  /**
   * 改用户：姓名 / 角色 / 密码按需改，用户名不可改；Principal 没有 enabled 字段，
   * 不提供启用/停用。改密码即时生效（下次登录用新密码；旧令牌仍在有效期内）。
   */
  async updatePrincipal(id: string, input: UpdatePrincipalRequest): Promise<Principal> {
    const found = await this.db.findPrincipal(id);
    if (!found) throw new DomainError('NOT_FOUND', `用户 ${id} 不存在`, 404);
    if (input.displayName === undefined && input.roles === undefined && input.password === undefined) {
      throw new DomainError('INVALID_STATE', '没有要修改的字段', 400);
    }
    const merged: Principal = {
      ...found,
      displayName: input.displayName ?? found.displayName,
      roles: input.roles ?? found.roles,
    };
    let passwordHash: string;
    if (input.password !== undefined) {
      passwordHash = await bcrypt.hash(input.password, 10);
    } else {
      const stored = await this.db.findPasswordHash(found.username);
      if (!stored) throw new DomainError('INVALID_STATE', `用户 ${found.username} 没有口令记录`, 500);
      passwordHash = stored;
    }
    await this.db.savePrincipal(merged, passwordHash);
    return merged;
  }
}
