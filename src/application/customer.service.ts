import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  CreateCustomerRequest,
  Customer,
  PageQueryParams,
  SalesOrder,
  UpdateCustomerRequest,
} from '@erp/contracts';
import { DatabasePort, DomainError, type Page } from '../domain/ports';
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
