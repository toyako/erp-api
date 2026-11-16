import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  BalanceTransaction,
  CreateCustomerFollowupRequest,
  CreateCustomerRequest,
  Customer,
  CustomerFollowup,
  LevelRule,
  PageQueryParams,
  SalesOrder,
  TopupRequest,
  UpdateCustomerFollowupRequest,
  UpdateCustomerRequest,
  UpdateLevelRuleRequest,
} from '@erp/contracts';
import { DatabasePort, DomainError, type Page } from '../domain/ports';
import { resolveLevel } from '../domain/level-rules';
import { TENANT_ID } from './sales.service';

/** totalSpent 口径：该客户全部非 cancelled 订单的 amount 之和（货币 CNY） */
function spentByCustomer(orders: SalesOrder[]): Map<string, number> {
  const spent = new Map<string, number>();
  for (const order of orders) {
    if (order.status === 'cancelled' || !order.customerId) continue;
    spent.set(order.customerId, (spent.get(order.customerId) ?? 0) + order.total.amount);
  }
  return spent;
}

@Injectable()
export class CustomerService {
  constructor(private readonly db: DatabasePort) {}

  /** 分页循环拉全量订单再内存聚合，与 DashboardService 同款做法 */
  private async collectAllOrders(): Promise<SalesOrder[]> {
    const all: SalesOrder[] = [];
    let page = 1;
    for (;;) {
      const result = await this.db.listOrders({ page, pageSize: 200 });
      all.push(...result.items);
      if (all.length >= result.total || result.items.length === 0) break;
      page += 1;
    }
    return all;
  }

  private withSpent(customer: Customer, spent: Map<string, number>): Customer {
    return {
      ...customer,
      totalSpent: { amount: spent.get(customer.id) ?? 0, currency: 'CNY' },
    };
  }

  async listCustomers(params: PageQueryParams): Promise<Page<Customer>> {
    const page = await this.db.listCustomers(params);
    const spent = spentByCustomer(await this.collectAllOrders());
    return { ...page, items: page.items.map((c) => this.withSpent(c, spent)) };
  }

  async findCustomer(id: string): Promise<Customer> {
    const found = await this.db.findCustomer(id);
    if (!found) throw new DomainError('NOT_FOUND', `客户 ${id} 不存在`, 404);
    const spent = spentByCustomer(await this.collectAllOrders());
    return this.withSpent(found, spent);
  }

  async createCustomer(input: CreateCustomerRequest): Promise<Customer> {
    const existing = await this.collectAllCustomers();
    if (existing.some((c) => c.code === input.code)) {
      throw new DomainError('CONFLICT', `客户编码 ${input.code} 已存在`, 409);
    }
    const customer: Customer = {
      id: randomUUID(),
      tenantId: TENANT_ID,
      code: input.code,
      name: input.name,
      phone: input.phone ?? null,
      // 等级默认普通：直接调 service 时 Zod 的 .default() 不生效，这里再兜一层
      level: input.level ?? 'regular',
      enabled: true,
      totalSpent: { amount: 0, currency: 'CNY' },
      balance: { amount: 0, currency: 'CNY' },
      createdAt: new Date().toISOString(),
    };
    await this.db.saveCustomer(customer);
    return customer;
  }

  async updateCustomer(id: string, input: UpdateCustomerRequest): Promise<Customer> {
    const found = await this.db.findCustomer(id);
    if (!found) throw new DomainError('NOT_FOUND', `客户 ${id} 不存在`, 404);
    if (
      input.name === undefined &&
      input.phone === undefined &&
      input.level === undefined &&
      input.enabled === undefined
    ) {
      throw new DomainError('INVALID_STATE', '至少修改一个字段', 400);
    }
    const merged: Customer = {
      ...found,
      name: input.name ?? found.name,
      phone: input.phone ?? found.phone,
      level: input.level ?? found.level,
      enabled: input.enabled ?? found.enabled,
    };
    await this.db.saveCustomer(merged);
    const spent = spentByCustomer(await this.collectAllOrders());
    return this.withSpent(merged, spent);
  }

  /** 充值：同一事务内加余额 + 记流水；金额已由 Zod 保证 >0 */
  async topupCustomer(id: string, input: TopupRequest): Promise<Customer> {
    return this.db.runInTransaction(async (tx) => {
      const found = await tx.findCustomer(id);
      if (!found) throw new DomainError('NOT_FOUND', `客户 ${id} 不存在`, 404);
      const balanceAfter = {
        amount: found.balance.amount + input.amount.amount,
        currency: found.balance.currency,
      };
      const merged: Customer = { ...found, balance: balanceAfter };
      await tx.saveCustomer(merged);
      const record: BalanceTransaction = {
        id: randomUUID(),
        tenantId: TENANT_ID,
        customerId: id,
        kind: 'topup',
        amount: input.amount,
        balanceAfter,
        remark: input.remark ?? null,
        createdAt: new Date().toISOString(),
      };
      await tx.saveBalanceTransaction(record);
      const spent = spentByCustomer(await this.collectAllOrders());
      return this.withSpent(merged, spent);
    });
  }

  async listBalanceTransactions(id: string, params: PageQueryParams): Promise<Page<BalanceTransaction>> {
    const found = await this.db.findCustomer(id);
    if (!found) throw new DomainError('NOT_FOUND', `客户 ${id} 不存在`, 404);
    return this.db.listBalanceTransactions(params, { customerId: id });
  }

  async listFollowups(id: string, params: PageQueryParams): Promise<Page<CustomerFollowup>> {
    const found = await this.db.findCustomer(id);
    if (!found) throw new DomainError('NOT_FOUND', `客户 ${id} 不存在`, 404);
    return this.db.listFollowups(params, { customerId: id });
  }

  async createFollowup(id: string, input: CreateCustomerFollowupRequest): Promise<CustomerFollowup> {
    const found = await this.db.findCustomer(id);
    if (!found) throw new DomainError('NOT_FOUND', `客户 ${id} 不存在`, 404);
    const followup: CustomerFollowup = {
      id: randomUUID(),
      tenantId: TENANT_ID,
      customerId: id,
      content: input.content,
      nextAt: input.nextAt ?? null,
      done: false,
      createdAt: new Date().toISOString(),
    };
    await this.db.saveFollowup(followup);
    return followup;
  }

  async updateFollowup(id: string, input: UpdateCustomerFollowupRequest): Promise<CustomerFollowup> {
    const found = await this.db.findFollowup(id);
    if (!found) throw new DomainError('NOT_FOUND', `跟进记录 ${id} 不存在`, 404);
    if (input.content === undefined && input.nextAt === undefined && input.done === undefined) {
      throw new DomainError('INVALID_STATE', '至少修改一个字段', 400);
    }
    const merged: CustomerFollowup = {
      ...found,
      content: input.content ?? found.content,
      nextAt: input.nextAt !== undefined ? input.nextAt : found.nextAt,
      done: input.done ?? found.done,
    };
    await this.db.saveFollowup(merged);
    return merged;
  }

  async listLevelRules(): Promise<LevelRule[]> {
    return this.db.listLevelRules();
  }

  async updateLevelRule(level: string, input: UpdateLevelRuleRequest): Promise<LevelRule> {
    if (level !== 'regular' && level !== 'vip') {
      throw new DomainError('INVALID_STATE', `未知等级 ${level}`, 400);
    }
    const rules = await this.db.listLevelRules();
    const found = rules.find((r) => r.level === level);
    if (!found) throw new DomainError('NOT_FOUND', `等级规则 ${level} 不存在`, 404);
    const merged: LevelRule = { ...found, minSpent: input.minSpent };
    await this.db.saveLevelRule(merged);
    return merged;
  }

  /**
   * 按累计消费重评等级：订单新建/取消后由控制器调用；客户不存在返回 null；
   * 等级没变不写库。失败不抛给调用方之外的上层——控制器包 try/catch。
   */
  async reevaluateLevel(customerId: string): Promise<Customer | null> {
    const found = await this.db.findCustomer(customerId);
    if (!found) return null;
    const spent = spentByCustomer(await this.collectAllOrders());
    const total = spent.get(customerId) ?? 0;
    const rules = await this.db.listLevelRules();
    const level = resolveLevel(total, rules);
    if (level === found.level) return this.withSpent(found, spent);
    const merged: Customer = { ...found, level };
    await this.db.saveCustomer(merged);
    return this.withSpent(merged, spent);
  }

  /** 编码查重用：分页循环拉全量客户 */
  private async collectAllCustomers(): Promise<Customer[]> {
    const all: Customer[] = [];
    let page = 1;
    for (;;) {
      const result = await this.db.listCustomers({ page, pageSize: 200 });
      all.push(...result.items);
      if (all.length >= result.total || result.items.length === 0) break;
      page += 1;
    }
    return all;
  }
}
