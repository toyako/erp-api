import { Injectable } from '@nestjs/common';
import type {
  Customer,
  InventoryLot,
  OrderLine,
  PageQueryParams,
  PriceList,
  Principal,
  PurchaseOrder,
  PurchaseOrderLine,
  Rma,
  Role,
  SalesOrder,
  Sku,
  Stocktake,
  Supplier,
  Transfer,
} from '@erp/contracts';
import { Prisma, PrismaClient } from '@prisma/client';
import { DatabasePort, type Page } from '../domain/ports';

type Client = PrismaClient | Prisma.TransactionClient;

function toPrincipal(row: {
  id: string;
  tenantId: string;
  username: string;
  displayName: string;
  roles: string[];
}): Principal {
  return {
    id: row.id,
    tenantId: row.tenantId,
    username: row.username,
    displayName: row.displayName,
    roles: row.roles as Role[],
  };
}

function toSku(row: {
  id: string;
  spuId: string;
  code: string;
  spec: string;
  unit: string;
  enabled: boolean;
}): Sku {
  return {
    id: row.id,
    spuId: row.spuId,
    code: row.code,
    spec: row.spec,
    unit: row.unit,
    enabled: row.enabled,
  };
}

function toLot(row: {
  id: string;
  tenantId: string;
  skuId: string;
  batchCode: string;
  location: string;
  availableQty: number;
  reservedQty: number;
  totalQty: number;
}): InventoryLot {
  return {
    id: row.id,
    tenantId: row.tenantId,
    skuId: row.skuId,
    batchCode: row.batchCode,
    location: row.location,
    availableQty: row.availableQty,
    reservedQty: row.reservedQty,
    totalQty: row.totalQty,
  };
}

function toSupplier(row: {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  contact: string | null;
  phone: string | null;
  rating: number;
  enabled: boolean;
}): Supplier {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    ...(row.contact ? { contact: row.contact } : {}),
    ...(row.phone ? { phone: row.phone } : {}),
    rating: row.rating,
    enabled: row.enabled,
  };
}

function toCustomer(row: {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  phone: string | null;
  level: string;
  enabled: boolean;
  createdAt: Date;
}): Customer {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    phone: row.phone,
    level: row.level as Customer['level'],
    enabled: row.enabled,
    // 累计消费不在库里存，由 CustomerService 聚合订单算出
    totalSpent: { amount: 0, currency: 'CNY' },
    createdAt: row.createdAt.toISOString(),
  };
}

function toRma(row: {
  id: string;
  tenantId: string;
  rmaNo: string;
  orderId: string;
  skuId: string;
  quantity: number;
  reason: string;
  status: string;
  refundAmount: number;
  currency: string;
  createdAt: Date;
  receivedAt: Date | null;
}): Rma {
  return {
    id: row.id,
    tenantId: row.tenantId,
    rmaNo: row.rmaNo,
    orderId: row.orderId,
    skuId: row.skuId,
    quantity: row.quantity,
    reason: row.reason,
    status: row.status as Rma['status'],
    refundAmount: { amount: row.refundAmount, currency: row.currency },
    createdAt: row.createdAt.toISOString(),
    receivedAt: row.receivedAt ? row.receivedAt.toISOString() : null,
  };
}

function toTransfer(row: {
  id: string;
  tenantId: string;
  transferNo: string;
  skuId: string;
  fromLocation: string;
  toLocation: string;
  quantity: number;
  status: string;
  batchCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
}): Transfer {
  return {
    id: row.id,
    tenantId: row.tenantId,
    transferNo: row.transferNo,
    skuId: row.skuId,
    fromLocation: row.fromLocation,
    toLocation: row.toLocation,
    quantity: row.quantity,
    status: row.status as Transfer['status'],
    batchCode: row.batchCode,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

function toStocktake(row: {
  id: string;
  tenantId: string;
  stocktakeNo: string;
  lotId: string;
  skuId: string;
  countedQty: number;
  systemQty: number;
  difference: number;
  status: string;
  createdAt: Date;
  confirmedAt: Date | null;
}): Stocktake {
  return {
    id: row.id,
    tenantId: row.tenantId,
    stocktakeNo: row.stocktakeNo,
    lotId: row.lotId,
    skuId: row.skuId,
    countedQty: row.countedQty,
    systemQty: row.systemQty,
    difference: row.difference,
    status: row.status as Stocktake['status'],
    createdAt: row.createdAt.toISOString(),
    confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
  };
}

/** 分页参数换算：Prisma skip/take */
function pageArgs(params: PageQueryParams) {
  return { skip: (params.page - 1) * params.pageSize, take: params.pageSize };
}

/** 组装分页结果，与 HTTP 响应形状一致 */
function toPage<T>(items: T[], total: number, params: PageQueryParams): Page<T> {
  return { items, total, page: params.page, pageSize: params.pageSize };
}

function toPrice(row: {
  id: string;
  skuId: string;
  channelCode: string;
  amount: number;
  currency: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}): PriceList {
  return {
    id: row.id,
    skuId: row.skuId,
    channelCode: row.channelCode,
    price: { amount: row.amount, currency: row.currency },
    effectiveFrom: row.effectiveFrom.toISOString(),
    ...(row.effectiveTo ? { effectiveTo: row.effectiveTo.toISOString() } : {}),
  };
}

/** 生产适配器：Supabase / 自建 PostgreSQL，实现同一 DatabasePort */
@Injectable()
export class PrismaDatabase extends DatabasePort {
  constructor(private readonly client: Client) {
    super();
  }

  async findPrincipalByUsername(username: string) {
    const row = await this.client.principal.findUnique({ where: { username } });
    return row ? toPrincipal(row) : null;
  }

  async findPasswordHash(username: string) {
    const row = await this.client.principal.findUnique({
      where: { username },
      select: { passwordHash: true },
    });
    return row?.passwordHash ?? null;
  }

  async listPrincipals(params: PageQueryParams) {
    const [rows, total] = await Promise.all([
      this.client.principal.findMany({ orderBy: { username: 'asc' }, ...pageArgs(params) }),
      this.client.principal.count(),
    ]);
    return toPage(rows.map(toPrincipal), total, params);
  }

  async listSkus(params: PageQueryParams) {
    const [rows, total] = await Promise.all([
      this.client.sku.findMany({ orderBy: { code: 'asc' }, ...pageArgs(params) }),
      this.client.sku.count(),
    ]);
    return toPage(rows.map(toSku), total, params);
  }

  async findSku(id: string) {
    const row = await this.client.sku.findUnique({ where: { id } });
    return row ? toSku(row) : null;
  }

  async saveSku(sku: Sku) {
    await this.client.sku.upsert({
      where: { id: sku.id },
      create: {
        id: sku.id,
        spuId: sku.spuId,
        code: sku.code,
        spec: sku.spec,
        unit: sku.unit,
        enabled: sku.enabled,
      },
      update: { spec: sku.spec, unit: sku.unit, enabled: sku.enabled },
    });
  }

  async findPriceBySku(skuId: string) {
    const row = await this.client.priceList.findFirst({
      where: { skuId, effectiveTo: null },
      orderBy: { effectiveFrom: 'desc' },
    });
    return row ? toPrice(row) : null;
  }

  async listLots(params: PageQueryParams) {
    const [rows, total] = await Promise.all([
      this.client.inventoryLot.findMany({ orderBy: { batchCode: 'asc' }, ...pageArgs(params) }),
      this.client.inventoryLot.count(),
    ]);
    return toPage(rows.map(toLot), total, params);
  }

  async findLot(id: string) {
    const row = await this.client.inventoryLot.findUnique({ where: { id } });
    return row ? toLot(row) : null;
  }

  async findLotBySku(skuId: string) {
    const row = await this.client.inventoryLot.findFirst({ where: { skuId } });
    return row ? toLot(row) : null;
  }

  async saveLot(lot: InventoryLot) {
    await this.client.inventoryLot.upsert({
      where: { id: lot.id },
      create: {
        id: lot.id,
        tenantId: lot.tenantId,
        skuId: lot.skuId,
        batchCode: lot.batchCode,
        location: lot.location,
        availableQty: lot.availableQty,
        reservedQty: lot.reservedQty,
        totalQty: lot.totalQty,
      },
      update: {
        availableQty: lot.availableQty,
        reservedQty: lot.reservedQty,
        totalQty: lot.totalQty,
      },
    });
  }

  async saveOrder(order: SalesOrder) {
    await this.client.salesOrder.upsert({
      where: { id: order.id },
      create: {
        id: order.id,
        tenantId: order.tenantId,
        orderNo: order.orderNo,
        customerId: order.customerId ?? null,
        status: order.status,
        amount: order.total.amount,
        currency: order.total.currency,
        createdAt: new Date(order.createdAt),
      },
      update: { status: order.status, amount: order.total.amount, customerId: order.customerId ?? null },
    });
    // schema 未定义反向关系字段，行项单独写入（事务超时已放宽到 20s）
    await this.client.orderLine.deleteMany({ where: { orderId: order.id } });
    await this.client.orderLine.createMany({
      data: order.lines.map((line) => ({
        id: line.id,
        orderId: order.id,
        skuId: line.skuId,
        quantity: line.quantity,
        unitAmount: line.unitPrice.amount,
        currency: line.unitPrice.currency,
      })),
    });
  }

  async listSuppliers(params: PageQueryParams) {
    const [rows, total] = await Promise.all([
      this.client.supplier.findMany({ orderBy: { createdAt: 'asc' }, ...pageArgs(params) }),
      this.client.supplier.count(),
    ]);
    return toPage(rows.map(toSupplier), total, params);
  }

  async findSupplier(id: string) {
    const row = await this.client.supplier.findUnique({ where: { id } });
    return row ? toSupplier(row) : null;
  }

  async saveSupplier(supplier: Supplier) {
    await this.client.supplier.upsert({
      where: { id: supplier.id },
      create: {
        id: supplier.id,
        tenantId: supplier.tenantId,
        code: supplier.code,
        name: supplier.name,
        contact: supplier.contact ?? null,
        phone: supplier.phone ?? null,
        rating: supplier.rating,
        enabled: supplier.enabled,
      },
      update: {
        name: supplier.name,
        contact: supplier.contact ?? null,
        phone: supplier.phone ?? null,
        rating: supplier.rating,
        enabled: supplier.enabled,
      },
    });
  }

  async listCustomers(params: PageQueryParams) {
    const [rows, total] = await Promise.all([
      this.client.customer.findMany({ orderBy: { code: 'asc' }, ...pageArgs(params) }),
      this.client.customer.count(),
    ]);
    return toPage(rows.map(toCustomer), total, params);
  }

  async findCustomer(id: string) {
    const row = await this.client.customer.findUnique({ where: { id } });
    return row ? toCustomer(row) : null;
  }

  async saveCustomer(customer: Customer) {
    await this.client.customer.upsert({
      where: { id: customer.id },
      create: {
        id: customer.id,
        tenantId: customer.tenantId,
        code: customer.code,
        name: customer.name,
        phone: customer.phone,
        level: customer.level,
        enabled: customer.enabled,
      },
      update: {
        name: customer.name,
        phone: customer.phone,
        level: customer.level,
        enabled: customer.enabled,
      },
    });
  }

  async listOrders(params: PageQueryParams) {
    const [rows, total] = await Promise.all([
      this.client.salesOrder.findMany({ orderBy: { createdAt: 'desc' }, ...pageArgs(params) }),
      this.client.salesOrder.count(),
    ]);
    return toPage(await Promise.all(rows.map((row) => this.hydrate(row))), total, params);
  }

  async listRmas(params: PageQueryParams) {
    const [rows, total] = await Promise.all([
      this.client.rma.findMany({ orderBy: { createdAt: 'desc' }, ...pageArgs(params) }),
      this.client.rma.count(),
    ]);
    return toPage(rows.map(toRma), total, params);
  }

  async findRma(id: string) {
    const row = await this.client.rma.findUnique({ where: { id } });
    return row ? toRma(row) : null;
  }

  async saveRma(rma: Rma) {
    await this.client.rma.upsert({
      where: { id: rma.id },
      create: {
        id: rma.id,
        tenantId: rma.tenantId,
        rmaNo: rma.rmaNo,
        orderId: rma.orderId,
        skuId: rma.skuId,
        quantity: rma.quantity,
        reason: rma.reason,
        status: rma.status,
        refundAmount: rma.refundAmount.amount,
        currency: rma.refundAmount.currency,
        createdAt: new Date(rma.createdAt),
        receivedAt: rma.receivedAt ? new Date(rma.receivedAt) : null,
      },
      update: { status: rma.status, receivedAt: rma.receivedAt ? new Date(rma.receivedAt) : null },
    });
  }

  async listTransfers(params: PageQueryParams) {
    const [rows, total] = await Promise.all([
      this.client.transfer.findMany({ orderBy: { createdAt: 'desc' }, ...pageArgs(params) }),
      this.client.transfer.count(),
    ]);
    return toPage(rows.map(toTransfer), total, params);
  }

  async findTransfer(id: string) {
    const row = await this.client.transfer.findUnique({ where: { id } });
    return row ? toTransfer(row) : null;
  }

  async saveTransfer(transfer: Transfer) {
    await this.client.transfer.upsert({
      where: { id: transfer.id },
      create: {
        id: transfer.id,
        tenantId: transfer.tenantId,
        transferNo: transfer.transferNo,
        skuId: transfer.skuId,
        fromLocation: transfer.fromLocation,
        toLocation: transfer.toLocation,
        quantity: transfer.quantity,
        status: transfer.status,
        batchCode: transfer.batchCode,
        createdAt: new Date(transfer.createdAt),
        completedAt: transfer.completedAt ? new Date(transfer.completedAt) : null,
      },
      update: { status: transfer.status, batchCode: transfer.batchCode, completedAt: transfer.completedAt ? new Date(transfer.completedAt) : null },
    });
  }

  async listStocktakes(params: PageQueryParams) {
    const [rows, total] = await Promise.all([
      this.client.stocktake.findMany({ orderBy: { createdAt: 'desc' }, ...pageArgs(params) }),
      this.client.stocktake.count(),
    ]);
    return toPage(rows.map(toStocktake), total, params);
  }

  async findStocktake(id: string) {
    const row = await this.client.stocktake.findUnique({ where: { id } });
    return row ? toStocktake(row) : null;
  }

  async saveStocktake(stocktake: Stocktake) {
    await this.client.stocktake.upsert({
      where: { id: stocktake.id },
      create: {
        id: stocktake.id,
        tenantId: stocktake.tenantId,
        stocktakeNo: stocktake.stocktakeNo,
        lotId: stocktake.lotId,
        skuId: stocktake.skuId,
        countedQty: stocktake.countedQty,
        systemQty: stocktake.systemQty,
        difference: stocktake.difference,
        status: stocktake.status,
        createdAt: new Date(stocktake.createdAt),
        confirmedAt: stocktake.confirmedAt ? new Date(stocktake.confirmedAt) : null,
      },
      update: { status: stocktake.status, confirmedAt: stocktake.confirmedAt ? new Date(stocktake.confirmedAt) : null },
    });
  }

  async listPurchaseOrders(params: PageQueryParams) {
    const [rows, total] = await Promise.all([
      this.client.purchaseOrder.findMany({ orderBy: { createdAt: 'desc' }, ...pageArgs(params) }),
      this.client.purchaseOrder.count(),
    ]);
    return toPage(await Promise.all(rows.map((row) => this.hydratePurchaseOrder(row))), total, params);
  }

  async findPurchaseOrder(id: string) {
    const row = await this.client.purchaseOrder.findUnique({ where: { id } });
    return row ? this.hydratePurchaseOrder(row) : null;
  }

  async savePurchaseOrder(order: PurchaseOrder) {
    await this.client.purchaseOrder.upsert({
      where: { id: order.id },
      create: {
        id: order.id,
        tenantId: order.tenantId,
        orderNo: order.orderNo,
        supplierId: order.supplierId,
        status: order.status,
        amount: order.total.amount,
        currency: order.total.currency,
        createdAt: new Date(order.createdAt),
      },
      update: { status: order.status, amount: order.total.amount },
    });
    // schema 未定义反向关系字段，行项单独写入（事务超时已放宽到 20s）
    await this.client.purchaseOrderLine.deleteMany({ where: { orderId: order.id } });
    await this.client.purchaseOrderLine.createMany({
      data: order.lines.map((line) => ({
        id: line.id,
        orderId: order.id,
        skuId: line.skuId,
        quantity: line.quantity,
        unitAmount: line.unitPrice.amount,
        currency: line.unitPrice.currency,
      })),
    });
  }

  async findOrder(id: string) {
    const row = await this.client.salesOrder.findUnique({ where: { id } });
    return row ? this.hydrate(row) : null;
  }

  /** 用交互式事务保证「占库存 + 建订单」原子性；回调拿到事务内句柄 */
  async runInTransaction<T>(fn: (tx: DatabasePort) => Promise<T>): Promise<T> {
    if (!('$transaction' in this.client)) return fn(this);
    return this.client.$transaction(async (tx) => fn(new PrismaDatabase(tx)), {
      maxWait: 10_000,
      timeout: 20_000,
    });
  }

  private async hydrate(row: {
    id: string;
    tenantId: string;
    orderNo: string;
    customerId: string | null;
    status: string;
    amount: number;
    currency: string;
    createdAt: Date;
  }): Promise<SalesOrder> {
    const lines = await this.client.orderLine.findMany({ where: { orderId: row.id } });
    return {
      id: row.id,
      tenantId: row.tenantId,
      orderNo: row.orderNo,
      ...(row.customerId ? { customerId: row.customerId } : {}),
      status: row.status as SalesOrder['status'],
      lines: lines.map(
        (line): OrderLine => ({
          id: line.id,
          skuId: line.skuId,
          quantity: line.quantity,
          unitPrice: { amount: line.unitAmount, currency: line.currency },
        }),
      ),
      total: { amount: row.amount, currency: row.currency },
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async hydratePurchaseOrder(row: {
    id: string;
    tenantId: string;
    orderNo: string;
    supplierId: string;
    status: string;
    amount: number;
    currency: string;
    createdAt: Date;
  }): Promise<PurchaseOrder> {
    const lines = await this.client.purchaseOrderLine.findMany({ where: { orderId: row.id } });
    return {
      id: row.id,
      tenantId: row.tenantId,
      orderNo: row.orderNo,
      supplierId: row.supplierId,
      status: row.status as PurchaseOrder['status'],
      lines: lines.map(
        (line): PurchaseOrderLine => ({
          id: line.id,
          skuId: line.skuId,
          quantity: line.quantity,
          unitPrice: { amount: line.unitAmount, currency: line.currency },
        }),
      ),
      total: { amount: row.amount, currency: row.currency },
      createdAt: row.createdAt.toISOString(),
    };
  }
}
