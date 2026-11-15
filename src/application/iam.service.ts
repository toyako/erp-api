import { Injectable } from '@nestjs/common';
import { LoginRequestSchema, type LoginResponse, type Principal } from '@erp/contracts';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { DatabasePort, DomainError } from '../domain/ports';

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

  listPrincipals() {
    return this.db.listPrincipals();
  }
}
