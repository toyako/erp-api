import { Injectable } from '@nestjs/common';
import type {
  InventoryLot,
  PriceList,
  Principal,
  SalesOrder,
  Sku,
} from '@erp/contracts';
import { DatabasePort } from '../domain/ports';
import { TENANT_ID } from '../application/sales.service';

interface State {
  credentials: Record<string, string>;
  principals: Principal[];
  skus: Sku[];
  prices: PriceList[];
  lots: InventoryLot[];
  orders: SalesOrder[];
}

const skuA = '00000000-0000-4000-8000-000000000101';
const skuB = '00000000-0000-4000-8000-000000000102';

function seed(): State {
  const principals: Principal[] = [
    { id: '00000000-0000-4000-8000-000000000011', tenantId: TENANT_ID, username: 'admin', displayName: '管理员', roles: ['admin'] },
    { id: '00000000-0000-4000-8000-000000000012', tenantId: TENANT_ID, username: 'sales', displayName: '销售', roles: ['sales'] },
    { id: '00000000-0000-4000-8000-000000000013', tenantId: TENANT_ID, username: 'viewer', displayName: '只读', roles: ['readonly'] },
  ];
  const skus: Sku[] = [
    { id: skuA, spuId: '00000000-0000-4000-8000-000000000100', code: 'SKU-001', spec: '标准版', unit: '件', enabled: true },
    { id: skuB, spuId: '00000000-0000-4000-8000-000000000100', code: 'SKU-002', spec: '专业版', unit: '件', enabled: true },
  ];
  const prices: PriceList[] = [
    { id: '00000000-0000-4000-8000-000000000301', skuId: skuA, channelCode: 'default', price: { amount: 19900, currency: 'CNY' }, effectiveFrom: '2026-01-01T00:00:00.000Z' },
    { id: '00000000-0000-4000-8000-000000000302', skuId: skuB, channelCode: 'default', price: { amount: 39900, currency: 'CNY' }, effectiveFrom: '2026-01-01T00:00:00.000Z' },
  ];
  const lots: InventoryLot[] = [
    { id: '00000000-0000-4000-8000-000000000201', tenantId: TENANT_ID, skuId: skuA, batchCode: 'BATCH-001', availableQty: 100, reservedQty: 0, totalQty: 100 },
    { id: '00000000-0000-4000-8000-000000000202', tenantId: TENANT_ID, skuId: skuB, batchCode: 'BATCH-002', availableQty: 50, reservedQty: 0, totalQty: 50 },
  ];
  return {
    credentials: { admin: 'demo1234', sales: 'demo1234', viewer: 'demo1234' },
    principals,
    skus,
    prices,
    lots,
    orders: [],
  };
}

/** 演示适配器：无外部依赖，可离线运行；生产适配器用 Prisma 实现同一端口 */
@Injectable()
export class InMemoryDatabase extends DatabasePort {
  private state: State = seed();

  /** 一律返回副本，防止调用方绕过仓储直接修改内部状态 */
  async findPrincipalByUsername(username: string) {
    const found = this.state.principals.find((p) => p.username === username);
    return found ? { ...found } : null;
  }
  /** 演示适配器存明文口令；Prisma 适配器存 bcrypt hash */
  async findPasswordHash(username: string) {
    return username in this.state.credentials ? this.state.credentials[username] ?? null : null;
  }
  async listPrincipals() { return this.state.principals.map((p) => ({ ...p })); }
  async listSkus() { return this.state.skus.map((s) => ({ ...s })); }
  async findSku(id: string) {
    const found = this.state.skus.find((s) => s.id === id);
    return found ? { ...found } : null;
  }
  async findPriceBySku(skuId: string) {
    const found = this.state.prices.find((p) => p.skuId === skuId);
    return found ? { ...found } : null;
  }
  async listLots() { return this.state.lots.map((l) => ({ ...l })); }
  async findLotBySku(skuId: string) {
    const found = this.state.lots.find((l) => l.skuId === skuId);
    return found ? { ...found } : null;
  }

  async saveLot(lot: InventoryLot) {
    const i = this.state.lots.findIndex((l) => l.id === lot.id);
    const copy = { ...lot };
    if (i >= 0) this.state.lots[i] = copy;
    else this.state.lots.push(copy);
  }

  async saveOrder(order: SalesOrder) {
    const i = this.state.orders.findIndex((o) => o.id === order.id);
    const copy = { ...order };
    if (i >= 0) this.state.orders[i] = copy;
    else this.state.orders.push(copy);
  }

  async listOrders() { return this.state.orders.map((o) => ({ ...o })); }
  async findOrder(id: string) {
    const found = this.state.orders.find((o) => o.id === id);
    return found ? { ...found } : null;
  }

  /** 失败时回滚到事务前快照，保证「占库存 + 建订单」原子性 */
  async runInTransaction<T>(fn: (tx: DatabasePort) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.state);
    try {
      return await fn(this);
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }
}
