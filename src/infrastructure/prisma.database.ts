import { Injectable } from '@nestjs/common';
import type {
  InventoryLot,
  OrderLine,
  PriceList,
  Principal,
  Role,
  SalesOrder,
  Sku,
} from '@erp/contracts';
import { Prisma, PrismaClient } from '@prisma/client';
import { DatabasePort } from '../domain/ports';

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
  availableQty: number;
  reservedQty: number;
  totalQty: number;
}): InventoryLot {
  return {
    id: row.id,
    tenantId: row.tenantId,
    skuId: row.skuId,
    batchCode: row.batchCode,
    availableQty: row.availableQty,
    reservedQty: row.reservedQty,
    totalQty: row.totalQty,
  };
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

  async listPrincipals() {
    const rows = await this.client.principal.findMany();
    return rows.map(toPrincipal);
  }

  async listSkus() {
    const rows = await this.client.sku.findMany();
    return rows.map(toSku);
  }

  async findSku(id: string) {
    const row = await this.client.sku.findUnique({ where: { id } });
    return row ? toSku(row) : null;
  }

  async findPriceBySku(skuId: string) {
    const row = await this.client.priceList.findFirst({
      where: { skuId, effectiveTo: null },
      orderBy: { effectiveFrom: 'desc' },
    });
    return row ? toPrice(row) : null;
  }

  async listLots() {
    const rows = await this.client.inventoryLot.findMany();
    return rows.map(toLot);
  }

  async findLotBySku(skuId: string) {
    const row = await this.client.inventoryLot.findFirst({ where: { skuId } });
    return row ? toLot(row) : null;
  }

  async saveLot(lot: InventoryLot) {
    await this.client.inventoryLot.update({
      where: { id: lot.id },
      data: {
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
        status: order.status,
        amount: order.total.amount,
        currency: order.total.currency,
        createdAt: new Date(order.createdAt),
      },
      update: { status: order.status, amount: order.total.amount },
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

  async listOrders() {
    const rows = await this.client.salesOrder.findMany({ orderBy: { createdAt: 'desc' } });
    return Promise.all(rows.map((row) => this.hydrate(row)));
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
}
