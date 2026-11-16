import { Injectable } from '@nestjs/common';
import type {
  AuditEvent,
  AuditEventListQuery,
  Customer,
  InventoryLot,
  PageQueryParams,
  PriceList,
  Principal,
  PurchaseOrder,
  Rma,
  SalesOrder,
  Shipment,
  Sku,
  Spu,
  Stocktake,
  Supplier,
  Transfer,
} from '@erp/contracts';
import { DEFAULT_LOCATION } from '@erp/contracts';
import { DatabasePort, type Page } from '../domain/ports';
import { TENANT_ID } from '../application/sales.service';

interface State {
  credentials: Record<string, string>;
  principals: Principal[];
  spus: Spu[];
  skus: Sku[];
  prices: PriceList[];
  lots: InventoryLot[];
  orders: SalesOrder[];
  suppliers: Supplier[];
  purchaseOrders: PurchaseOrder[];
  customers: Customer[];
  rmas: Rma[];
  shipments: Shipment[];
  transfers: Transfer[];
  stocktakes: Stocktake[];
  auditEvents: AuditEvent[];
}

const spuId = '00000000-0000-4000-8000-000000000100';
const skuA = '00000000-0000-4000-8000-000000000101';
const skuB = '00000000-0000-4000-8000-000000000102';

function seed(): State {
  const principals: Principal[] = [
    { id: '00000000-0000-4000-8000-000000000011', tenantId: TENANT_ID, username: 'admin', displayName: '管理员', roles: ['admin'] },
    { id: '00000000-0000-4000-8000-000000000012', tenantId: TENANT_ID, username: 'sales', displayName: '销售', roles: ['sales'] },
    { id: '00000000-0000-4000-8000-000000000013', tenantId: TENANT_ID, username: 'viewer', displayName: '只读', roles: ['readonly'] },
  ];
  const spus: Spu[] = [
    { id: spuId, tenantId: TENANT_ID, name: '云智物标准套件', categoryCode: 'SOFTWARE', description: '演示商品，数据全部虚构', enabled: true },
  ];
  const skus: Sku[] = [
    { id: skuA, spuId, code: 'SKU-001', spec: '标准版', unit: '套', enabled: true },
    { id: skuB, spuId, code: 'SKU-002', spec: '专业版', unit: '套', enabled: true },
  ];
  const prices: PriceList[] = [
    { id: '00000000-0000-4000-8000-000000000301', skuId: skuA, channelCode: 'DIRECT', price: { amount: 19900, currency: 'CNY' }, effectiveFrom: '2026-01-01T00:00:00.000Z' },
    { id: '00000000-0000-4000-8000-000000000302', skuId: skuB, channelCode: 'DIRECT', price: { amount: 29900, currency: 'CNY' }, effectiveFrom: '2026-01-01T00:00:00.000Z' },
  ];
  const lots: InventoryLot[] = [
    { id: '00000000-0000-4000-8000-000000000201', tenantId: TENANT_ID, skuId: skuA, batchCode: 'BATCH-001', location: DEFAULT_LOCATION, availableQty: 100, reservedQty: 0, totalQty: 100 },
    { id: '00000000-0000-4000-8000-000000000202', tenantId: TENANT_ID, skuId: skuB, batchCode: 'BATCH-002', location: '华东仓', availableQty: 50, reservedQty: 0, totalQty: 50 },
  ];
  /**
   * 演示退货单：与 Prisma seed / admin 演示兜底同口径（RMA-DEMO-001、SKU-001 ×1、¥199、待审核）。
   * InMemory 种子里没有销售订单，orderId 用固定演示值，仅供列表与待办/流水派生展示。
   */
  const rmas: Rma[] = [
    { id: '00000000-0000-4000-8000-000000000902', tenantId: TENANT_ID, rmaNo: 'RMA-DEMO-001', orderId: '00000000-0000-4000-8000-000000000901', skuId: skuA, quantity: 1, reason: '质量问题', status: 'requested', refundAmount: { amount: 19900, currency: 'CNY' }, rejectReason: null, createdAt: '2026-11-16T00:00:00.000Z', receivedAt: null },
  ];
  /**
   * 演示调拨与盘点：与 Prisma seed / admin 演示兜底同口径（TRF-DEMO-001 主仓→华东仓 ×5 草稿待提交；
   * STK-DEMO-001 针对 BATCH-001 实盘 100、系统 100、差异 0 待确认）。数量与种子批次一致，未动 lots。
   */
  const transfers: Transfer[] = [
    { id: '00000000-0000-4000-8000-000000000903', tenantId: TENANT_ID, transferNo: 'TRF-DEMO-001', skuId: skuA, fromLocation: DEFAULT_LOCATION, toLocation: '华东仓', quantity: 5, status: 'draft', batchCode: null, rejectReason: null, createdAt: '2026-11-16T00:00:00.000Z', completedAt: null },
  ];
  const stocktakes: Stocktake[] = [
    { id: '00000000-0000-4000-8000-000000000904', tenantId: TENANT_ID, stocktakeNo: 'STK-DEMO-001', lotId: '00000000-0000-4000-8000-000000000201', skuId: skuA, countedQty: 100, systemQty: 100, difference: 0, status: 'draft', createdAt: '2026-11-16T00:00:00.000Z', confirmedAt: null },
  ];
  return {
    credentials: { admin: 'demo1234', sales: 'demo1234', viewer: 'demo1234' },
    principals,
    spus,
    skus,
    prices,
    lots,
    orders: [],
    suppliers: [],
    purchaseOrders: [],
    customers: [],
    rmas,
    shipments: [],
    transfers,
    stocktakes,
    auditEvents: [],
  };
}

/** 内存分页：对已有数组切片 + total，与 HTTP 响应形状一致 */
function pageOf<T>(all: T[], params: PageQueryParams): Page<T> {
  const start = (params.page - 1) * params.pageSize;
  return { items: all.slice(start, start + params.pageSize), total: all.length, page: params.page, pageSize: params.pageSize };
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
  async findPrincipal(id: string) {
    const found = this.state.principals.find((p) => p.id === id);
    return found ? { ...found } : null;
  }
  async savePrincipal(principal: Principal, passwordHash: string) {
    const i = this.state.principals.findIndex((p) => p.id === principal.id);
    if (i >= 0) this.state.principals[i] = { ...principal };
    else this.state.principals.push({ ...principal });
    this.state.credentials[principal.username] = passwordHash;
  }
  async listPrincipals(params: PageQueryParams) { return pageOf(this.state.principals.map((p) => ({ ...p })), params); }
  async listSpus(params: PageQueryParams) {
    const sorted = [...this.state.spus].sort((a, b) => a.name.localeCompare(b.name));
    return pageOf(sorted.map((s) => ({ ...s })), params);
  }
  async findSpu(id: string) {
    const found = this.state.spus.find((s) => s.id === id);
    return found ? { ...found } : null;
  }
  async listSkus(params: PageQueryParams) { return pageOf(this.state.skus.map((s) => ({ ...s })), params); }
  async findSku(id: string) {
    const found = this.state.skus.find((s) => s.id === id);
    return found ? { ...found } : null;
  }
  async saveSku(sku: Sku) {
    const i = this.state.skus.findIndex((s) => s.id === sku.id);
    const copy = { ...sku };
    if (i >= 0) this.state.skus[i] = copy;
    else this.state.skus.push(copy);
  }
  /** 与 Prisma 适配器同口径：取未截止记录中生效最晚的一条 */
  async findPriceBySku(skuId: string) {
    const found = this.state.prices
      .filter((p) => p.skuId === skuId && !p.effectiveTo)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    return found ? { ...found } : null;
  }
  async listPrices(params: PageQueryParams) {
    const sorted = [...this.state.prices].sort(
      (a, b) => a.skuId.localeCompare(b.skuId) || b.effectiveFrom.localeCompare(a.effectiveFrom),
    );
    return pageOf(sorted.map((p) => ({ ...p })), params);
  }
  async findPrice(id: string) {
    const found = this.state.prices.find((p) => p.id === id);
    return found ? { ...found } : null;
  }
  async savePrice(price: PriceList) {
    const i = this.state.prices.findIndex((p) => p.id === price.id);
    const copy = { ...price };
    if (i >= 0) this.state.prices[i] = copy;
    else this.state.prices.push(copy);
  }
  async listLots(params: PageQueryParams) { return pageOf(this.state.lots.map((l) => ({ ...l })), params); }
  async findLot(id: string) {
    const found = this.state.lots.find((l) => l.id === id);
    return found ? { ...found } : null;
  }
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

  async listSuppliers(params: PageQueryParams) {
    return pageOf(this.state.suppliers.map((s) => ({ ...s })), params);
  }

  async findSupplier(id: string) {
    const found = this.state.suppliers.find((s) => s.id === id);
    return found ? { ...found } : null;
  }

  async saveSupplier(supplier: Supplier) {
    const index = this.state.suppliers.findIndex((s) => s.id === supplier.id);
    const copy = { ...supplier };
    if (index >= 0) this.state.suppliers[index] = copy;
    else this.state.suppliers.push(copy);
  }

  async listOrders(params: PageQueryParams) { return pageOf(this.state.orders.map((o) => ({ ...o })), params); }
  async findOrder(id: string) {
    const found = this.state.orders.find((o) => o.id === id);
    return found ? { ...found } : null;
  }

  async listPurchaseOrders(params: PageQueryParams) { return pageOf(this.state.purchaseOrders.map((o) => ({ ...o })), params); }
  async findPurchaseOrder(id: string) {
    const found = this.state.purchaseOrders.find((o) => o.id === id);
    return found ? { ...found } : null;
  }

  async savePurchaseOrder(order: PurchaseOrder) {
    const i = this.state.purchaseOrders.findIndex((o) => o.id === order.id);
    const copy = { ...order };
    if (i >= 0) this.state.purchaseOrders[i] = copy;
    else this.state.purchaseOrders.push(copy);
  }

  async listCustomers(params: PageQueryParams) {
    const kw = params.search?.trim().toLowerCase() ?? '';
    const filtered = kw
      ? this.state.customers.filter((c) =>
          [c.code, c.name, c.phone ?? ''].some((v) => v.toLowerCase().includes(kw)),
        )
      : this.state.customers;
    const sorted = [...filtered].sort((a, b) => a.code.localeCompare(b.code));
    return pageOf(sorted.map((c) => ({ ...c })), params);
  }

  async findCustomer(id: string) {
    const found = this.state.customers.find((c) => c.id === id);
    return found ? { ...found } : null;
  }

  async saveCustomer(customer: Customer) {
    const i = this.state.customers.findIndex((c) => c.id === customer.id);
    const copy = { ...customer };
    if (i >= 0) this.state.customers[i] = copy;
    else this.state.customers.push(copy);
  }

  async listRmas(params: PageQueryParams) {
    const sorted = [...this.state.rmas].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return pageOf(sorted.map((r) => ({ ...r })), params);
  }

  async findRma(id: string) {
    const found = this.state.rmas.find((r) => r.id === id);
    return found ? { ...found } : null;
  }

  async saveRma(rma: Rma) {
    const i = this.state.rmas.findIndex((r) => r.id === rma.id);
    const copy = { ...rma };
    if (i >= 0) this.state.rmas[i] = copy;
    else this.state.rmas.push(copy);
  }

  async listShipments(params: PageQueryParams) {
    const sorted = [...this.state.shipments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return pageOf(sorted.map((s) => ({ ...s, lines: s.lines.map((l) => ({ ...l })) })), params);
  }

  async findShipment(id: string) {
    const found = this.state.shipments.find((s) => s.id === id);
    return found ? { ...found, lines: found.lines.map((l) => ({ ...l })) } : null;
  }

  async saveShipment(shipment: Shipment) {
    const i = this.state.shipments.findIndex((s) => s.id === shipment.id);
    const copy = { ...shipment, lines: shipment.lines.map((l) => ({ ...l })) };
    if (i >= 0) this.state.shipments[i] = copy;
    else this.state.shipments.push(copy);
  }

  async listTransfers(params: PageQueryParams) {
    const sorted = [...this.state.transfers].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return pageOf(sorted.map((t) => ({ ...t })), params);
  }

  async findTransfer(id: string) {
    const found = this.state.transfers.find((t) => t.id === id);
    return found ? { ...found } : null;
  }

  async saveTransfer(transfer: Transfer) {
    const i = this.state.transfers.findIndex((t) => t.id === transfer.id);
    const copy = { ...transfer };
    if (i >= 0) this.state.transfers[i] = copy;
    else this.state.transfers.push(copy);
  }

  async listStocktakes(params: PageQueryParams) {
    const sorted = [...this.state.stocktakes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return pageOf(sorted.map((s) => ({ ...s })), params);
  }

  async findStocktake(id: string) {
    const found = this.state.stocktakes.find((s) => s.id === id);
    return found ? { ...found } : null;
  }

  async saveStocktake(stocktake: Stocktake) {
    const i = this.state.stocktakes.findIndex((s) => s.id === stocktake.id);
    const copy = { ...stocktake };
    if (i >= 0) this.state.stocktakes[i] = copy;
    else this.state.stocktakes.push(copy);
  }

  /** 审计列表：createdAt 倒序；entity 精确过滤、action 子串过滤，与 Prisma 适配器同口径 */
  async listAuditEvents(params: AuditEventListQuery) {
    const filtered = this.state.auditEvents.filter((e) => {
      if (params.entity && e.targetType !== params.entity) return false;
      if (params.action && !e.action.includes(params.action)) return false;
      return true;
    });
    const sorted = [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return pageOf(sorted.map((e) => ({ ...e, payload: e.payload ? { ...e.payload } : null })), params);
  }

  async findAuditEvent(id: string) {
    const found = this.state.auditEvents.find((e) => e.id === id);
    return found ? { ...found, payload: found.payload ? { ...found.payload } : null } : null;
  }

  async saveAuditEvent(event: AuditEvent) {
    const i = this.state.auditEvents.findIndex((e) => e.id === event.id);
    const copy = { ...event, payload: event.payload ? { ...event.payload } : null };
    if (i >= 0) this.state.auditEvents[i] = copy;
    else this.state.auditEvents.push(copy);
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
