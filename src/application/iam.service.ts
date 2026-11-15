import { Injectable } from '@nestjs/common';
import { LoginRequestSchema, type LoginResponse } from '@erp/contracts';
import { DatabasePort, DomainError } from '../domain/ports';

/** 演示环境固定口令，真实环境由 IdentityProvider 端口替换 */
const DEMO_PASSWORD = 'demo1234';

@Injectable()
export class IamService {
  constructor(private readonly db: DatabasePort) {}

  async login(input: unknown): Promise<LoginResponse> {
    const parsed = LoginRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new DomainError('FORBIDDEN', '用户名或密码格式不正确', 400);
    }
    const principal = await this.db.findPrincipalByUsername(parsed.data.username);
    if (!principal || parsed.data.password !== DEMO_PASSWORD) {
      throw new DomainError('FORBIDDEN', '用户名或密码错误', 401);
    }
    return {
      accessToken: `demo-token.${principal.id}`,
      expiresIn: 3600,
      principal,
    };
  }

  listPrincipals() {
    return this.db.listPrincipals();
  }
}
