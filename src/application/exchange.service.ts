import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DEFAULT_LOCATION } from '@erp/contracts';
import { resolveUnitPrice } from '../domain/pricing';
import type {
  CreateExchangeRequest,
  Exchange,
  ExchangeStatus,
  PageQueryParams,
} from '@erp/contracts';
import { DatabasePort, DomainError, type Page } from '../domain/ports';
import { nextDocNo } from '../domain/doc-no';
import { assertExchangeTransition } from '../domain/exchange-state';
import { TENANT_ID } from './sales.service';

/** 占可退余量的状态：已审核、已收货、已换货；requested / rejected / cancelled 不占余量 */
const COUNTED_STATUSES: readonly ExchangeStatus[] = ['approved', 'received', 'exchanged'];

/** 退货单占可退余量的状态（与 RmaService 同款；换货与退货共享同一可退余量） */
const RMA_COUNTED_STATUSES: readonly string[] = ['approved', 'received', 'refunded'];

@Injectable()
export class ExchangeService {
  constructor(private readonly db: DatabasePort) {}

  listExchanges(params: PageQueryParams) {
    return this.db.listExchanges(params);
  }

  async findExchange(id: string): Promise<Exchange> {
    const found = await this.db.findExchange(id);
    if (!found) throw new DomainError('NOT_FOUND', `换货单 ${id} 不存在`, 404);
    return found;
  }

  /**
   * 建单校验：订单存在且已发货（fulfilled）；退货 SKU 在该单里；数量不超过可退余量
   * （行数量 − 退货已占 − 换货已占）；换入 SKU 存在。
   * 差价由服务端算：换入数量 × 换入单价（按量取档）− 退货数量 × 订单行单价；
   * 正数=客户补差价，负数=应退差价，只记数，不走真实支付。
   */
  async createExchange(input: CreateExchangeRequest): Promise<Exchange> {
    return this.db.runInTransaction(async (tx) => {
      const order = await tx.findOrder(input.orderId);
      if (!order) throw new DomainError('NOT_FOUND', `订单 ${input.orderId} 不存在`, 404);
      if (order.status !== 'fulfilled') {
        throw new DomainError('INVALID_STATE', `订单 ${order.orderNo} 未发货，不能换货`, 409);
      }
      const line = order.lines.find((l) => l.skuId === input.returnSkuId);
      if (!line) {
        throw new DomainError('INVALID_STATE', `订单 ${order.orderNo} 里没有该 SKU`, 400);
      }
      const rmaUsed = (await this.collectAllRmas(tx))
        .filter((r) => r.orderId === order.id && r.skuId === input.returnSkuId && RMA_COUNTED_STATUSES.includes(r.status))
        .reduce((n, r) => n + r.quantity, 0);
      const exchangeUsed = (await this.collectAllExchanges(tx))
        .filter((e) => e.orderId === order.id && e.returnSkuId === input.returnSkuId && COUNTED_STATUSES.includes(e.status))
        .reduce((n, e) => n + e.returnQty, 0);
      const remaining = line.quantity - rmaUsed - exchangeUsed;
      if (input.returnQty > remaining) {
        throw new DomainError('CONFLICT', `可退余量不足（剩余 ${remaining} 件）`, 409);
      }
      const exchangeSku = await tx.findSku(input.exchangeSkuId);
      if (!exchangeSku) throw new DomainError('NOT_FOUND', `换入 SKU ${input.exchangeSkuId} 不存在`, 404);
      const { price: newUnitPrice } = await resolveUnitPrice(tx, input.exchangeSkuId, input.exchangeQty);
      const diff = input.exchangeQty * newUnitPrice.amount - input.returnQty * line.unitPrice.amount;
      const exchange: Exchange = {
        id: randomUUID(),
        tenantId: TENANT_ID,
        exchangeNo: nextDocNo('EXC'),
        orderId: order.id,
        returnSkuId: input.returnSkuId,
        returnQty: input.returnQty,
        exchangeSkuId: input.exchangeSkuId,
        exchangeQty: input.exchangeQty,
        diffAmount: { amount: diff, currency: 'CNY' },
        status: 'requested',
        rejectReason: null,
        createdAt: new Date().toISOString(),
        receivedAt: null,
        exchangedAt: null,
      };
      await tx.saveExchange(exchange);
      return exchange;
    });
  }

  async approveExchange(id: string): Promise<Exchange> {
    const exchange = await this.requireExchange(id);
    assertExchangeTransition(exchange.status, 'approved');
    exchange.status = 'approved';
    await this.db.saveExchange(exchange);
    return exchange;
  }

  /** 驳回：原因必填（无原因 400），落库到 rejectReason；只允许 requested → rejected */
  async rejectExchange(id: string, reason: string): Promise<Exchange> {
    const exchange = await this.requireExchange(id);
    if (!reason?.trim()) {
      throw new DomainError('INVALID_STATE', '驳回原因不能为空', 400);
    }
    assertExchangeTransition(exchange.status, 'rejected');
    exchange.status = 'rejected';
    exchange.rejectReason = reason.trim();
    await this.db.saveExchange(exchange);
    return exchange;
  }

  /**
   * 收货：退货腿回补库存，与退货 receive 同款——最早批次加数，无批次新建
   * （batchCode=换货单号，默认主仓）；整单同一事务。
   */
  async receiveExchange(id: string): Promise<Exchange> {
    return this.db.runInTransaction(async (tx) => {
      const exchange = await tx.findExchange(id);
      if (!exchange) throw new DomainError('NOT_FOUND', `换货单 ${id} 不存在`, 404);
      assertExchangeTransition(exchange.status, 'received');
      const lot = await tx.findLotBySku(exchange.returnSkuId);
      if (lot) {
        lot.availableQty += exchange.returnQty;
        lot.totalQty += exchange.returnQty;
        await tx.saveLot(lot);
      } else {
        await tx.saveLot({
          id: randomUUID(),
          tenantId: TENANT_ID,
          skuId: exchange.returnSkuId,
          batchCode: exchange.exchangeNo,
          location: DEFAULT_LOCATION,
          availableQty: exchange.returnQty,
          reservedQty: 0,
          totalQty: exchange.returnQty,
        });
      }
      exchange.status = 'received';
      exchange.receivedAt = new Date().toISOString();
      await tx.saveExchange(exchange);
      return exchange;
    });
  }

  /**
   * 完成换货：换入 SKU 从库存扣数（未被占用的量：总量与可用量同减）；
   * 库存不足 409；整单同一事务。
   */
  async completeExchange(id: string): Promise<Exchange> {
    return this.db.runInTransaction(async (tx) => {
      const exchange = await tx.findExchange(id);
      if (!exchange) throw new DomainError('NOT_FOUND', `换货单 ${id} 不存在`, 404);
      assertExchangeTransition(exchange.status, 'exchanged');
      const lot = await tx.findLotBySku(exchange.exchangeSkuId);
      if (!lot || lot.availableQty < exchange.exchangeQty) {
        throw new DomainError(
          'INSUFFICIENT_STOCK',
          `换入 SKU 库存不足（可用 ${lot?.availableQty ?? 0} 件，需 ${exchange.exchangeQty} 件）`,
          409,
        );
      }
      lot.totalQty -= exchange.exchangeQty;
      lot.availableQty = lot.totalQty - lot.reservedQty;
      await tx.saveLot(lot);
      exchange.status = 'exchanged';
      exchange.exchangedAt = new Date().toISOString();
      await tx.saveExchange(exchange);
      return exchange;
    });
  }

  /** 取消：只改状态，不动库存（收货已回补的不退回） */
  async cancelExchange(id: string): Promise<Exchange> {
    const exchange = await this.requireExchange(id);
    assertExchangeTransition(exchange.status, 'cancelled');
    exchange.status = 'cancelled';
    await this.db.saveExchange(exchange);
    return exchange;
  }

  /** 余量校验用：分页循环拉全量退货单（与 RmaService 同款） */
  private async collectAllRmas(db: DatabasePort) {
    const all: import('@erp/contracts').Rma[] = [];
    let page = 1;
    for (;;) {
      const result = await db.listRmas({ page, pageSize: 200 });
      all.push(...result.items);
      if (all.length >= result.total || result.items.length === 0) break;
      page += 1;
    }
    return all;
  }

  /** 余量校验用：分页循环拉全量换货单 */
  private async collectAllExchanges(db: DatabasePort): Promise<Exchange[]> {
    const all: Exchange[] = [];
    let page = 1;
    for (;;) {
      const result: Page<Exchange> = await db.listExchanges({ page, pageSize: 200 });
      all.push(...result.items);
      if (all.length >= result.total || result.items.length === 0) break;
      page += 1;
    }
    return all;
  }

  private async requireExchange(id: string): Promise<Exchange> {
    const exchange = await this.db.findExchange(id);
    if (!exchange) throw new DomainError('NOT_FOUND', `换货单 ${id} 不存在`, 404);
    return exchange;
  }
}
