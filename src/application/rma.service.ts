import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DEFAULT_LOCATION } from '@erp/contracts';
import { multiplyMoney } from '../domain/money';
import type {
  CreateRmaRequest,
  PageQueryParams,
  Rma,
  RmaStatus,
} from '@erp/contracts';
import { DatabasePort, DomainError, type Page } from '../domain/ports';
import { nextDocNo } from '../domain/doc-no';
import { assertRmaTransition } from '../domain/rma-state';
import { TENANT_ID } from './sales.service';

/** 占可退余量的状态：已审核、已收货、已退款；requested / rejected / cancelled 不占余量 */
const COUNTED_STATUSES: readonly RmaStatus[] = ['approved', 'received', 'refunded'];

@Injectable()
export class RmaService {
  constructor(private readonly db: DatabasePort) {}

  listRmas(params: PageQueryParams) {
    return this.db.listRmas(params);
  }

  async findRma(id: string): Promise<Rma> {
    const found = await this.db.findRma(id);
    if (!found) throw new DomainError('NOT_FOUND', `退货单 ${id} 不存在`, 404);
    return found;
  }

  /**
   * 建单校验：订单存在且已发货（fulfilled）；SKU 在该单里；数量不超过可退余量。
   * 退款金额由服务端按行单价 × 数量算，客户端不传金额；可退余量 = 行数量 − 已占余量。
   */
  async createRma(input: CreateRmaRequest): Promise<Rma> {
    return this.db.runInTransaction(async (tx) => {
      const order = await tx.findOrder(input.orderId);
      if (!order) throw new DomainError('NOT_FOUND', `订单 ${input.orderId} 不存在`, 404);
      if (order.status !== 'fulfilled') {
        throw new DomainError('INVALID_STATE', `订单 ${order.orderNo} 未发货，不能退货`, 409);
      }
      const line = order.lines.find((l) => l.skuId === input.skuId);
      if (!line) {
        throw new DomainError('INVALID_STATE', `订单 ${order.orderNo} 里没有该 SKU`, 400);
      }
      const used = (await this.collectAllRmas(tx))
        .filter((r) => r.orderId === order.id && r.skuId === input.skuId && COUNTED_STATUSES.includes(r.status))
        .reduce((n, r) => n + r.quantity, 0);
      const remaining = line.quantity - used;
      if (input.quantity > remaining) {
        throw new DomainError('CONFLICT', `可退余量不足（剩余 ${remaining} 件）`, 409);
      }
      const rma: Rma = {
        id: randomUUID(),
        tenantId: TENANT_ID,
        rmaNo: nextDocNo('RMA'),
        orderId: order.id,
        skuId: input.skuId,
        quantity: input.quantity,
        reason: input.reason,
        status: 'requested',
        refundAmount: multiplyMoney(line.unitPrice, input.quantity),
        rejectReason: null,
        createdAt: new Date().toISOString(),
        receivedAt: null,
      };
      await tx.saveRma(rma);
      return rma;
    });
  }

  async approveRma(id: string): Promise<Rma> {
    const rma = await this.requireRma(id);
    assertRmaTransition(rma.status, 'approved');
    rma.status = 'approved';
    await this.db.saveRma(rma);
    return rma;
  }

  /** 拒绝：原因必填（无原因 400），落库到 rejectReason；只允许 requested → rejected */
  async rejectRma(id: string, reason: string): Promise<Rma> {
    const rma = await this.requireRma(id);
    if (!reason?.trim()) {
      throw new DomainError('INVALID_STATE', '拒绝原因不能为空', 400);
    }
    assertRmaTransition(rma.status, 'rejected');
    rma.status = 'rejected';
    rma.rejectReason = reason.trim();
    await this.db.saveRma(rma);
    return rma;
  }

  /**
   * 确认收货（入库）：库存回补到该 SKU 最早批次（复用采购入库的找批次逻辑），
   * 无批次则新建一批次（batchCode 取退货单号）；记 receivedAt；整单同一事务。
   */
  async receiveRma(id: string): Promise<Rma> {
    return this.db.runInTransaction(async (tx) => {
      const rma = await tx.findRma(id);
      if (!rma) throw new DomainError('NOT_FOUND', `退货单 ${id} 不存在`, 404);
      assertRmaTransition(rma.status, 'received');
      const lot = await tx.findLotBySku(rma.skuId);
      if (lot) {
        lot.availableQty += rma.quantity;
        lot.totalQty += rma.quantity;
        await tx.saveLot(lot);
      } else {
        await tx.saveLot({
          id: randomUUID(),
          tenantId: TENANT_ID,
          skuId: rma.skuId,
          batchCode: rma.rmaNo,
          location: DEFAULT_LOCATION,
          availableQty: rma.quantity,
          reservedQty: 0,
          totalQty: rma.quantity,
        });
      }
      rma.status = 'received';
      rma.receivedAt = new Date().toISOString();
      await tx.saveRma(rma);
      return rma;
    });
  }

  /** 确认退款：只改状态，不接真实支付 */
  async refundRma(id: string): Promise<Rma> {
    const rma = await this.requireRma(id);
    assertRmaTransition(rma.status, 'refunded');
    rma.status = 'refunded';
    await this.db.saveRma(rma);
    return rma;
  }

  async cancelRma(id: string): Promise<Rma> {
    const rma = await this.requireRma(id);
    assertRmaTransition(rma.status, 'cancelled');
    rma.status = 'cancelled';
    await this.db.saveRma(rma);
    return rma;
  }

  /** 余量校验用：分页循环拉全量退货单 */
  private async collectAllRmas(db: DatabasePort): Promise<Rma[]> {
    const all: Rma[] = [];
    let page = 1;
    for (;;) {
      const result = await db.listRmas({ page, pageSize: 200 });
      all.push(...result.items);
      if (all.length >= result.total || result.items.length === 0) break;
      page += 1;
    }
    return all;
  }

  private async requireRma(id: string): Promise<Rma> {
    const rma = await this.db.findRma(id);
    if (!rma) throw new DomainError('NOT_FOUND', `退货单 ${id} 不存在`, 404);
    return rma;
  }
}
