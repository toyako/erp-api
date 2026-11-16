import { Injectable } from '@nestjs/common';
import { addMoney, multiplyMoney, zeroMoney } from '../domain/money';
import { randomUUID } from 'node:crypto';
import { DEFAULT_LOCATION } from '@erp/contracts';
import type {
  CreatePurchaseOrderRequest,
  GoodsReceipt,
  PageQueryParams,
  PurchaseOrder,
  PurchaseOrderLine,
  ReceivePurchaseOrderRequest,
} from '@erp/contracts';
import { DatabasePort, DomainError } from '../domain/ports';
import { nextDocNo } from '../domain/doc-no';
import { assertPurchaseTransition } from '../domain/purchase-state';
import { resolveUnitPrice } from '../domain/pricing';
import { TENANT_ID } from './sales.service';

@Injectable()
export class PurchaseService {
  constructor(private readonly db: DatabasePort) {}

  listPurchaseOrders(params: PageQueryParams) {
    return this.db.listPurchaseOrders(params);
  }

  listReceipts(params: PageQueryParams, purchaseOrderId?: string) {
    return this.db.listReceipts(params, purchaseOrderId ? { purchaseOrderId } : undefined);
  }

  findReceipt(id: string) {
    return this.db.findReceipt(id);
  }

  /** 金额只由服务端按价格表计算，请求体不含任何金额字段；建单不碰库存 */
  async createPurchaseOrder(input: CreatePurchaseOrderRequest): Promise<PurchaseOrder> {
    return this.db.runInTransaction(async (tx) => {
      const supplier = await tx.findSupplier(input.supplierId);
      if (!supplier) throw new DomainError('NOT_FOUND', `供应商 ${input.supplierId} 不存在`, 404);

      const lines: PurchaseOrderLine[] = [];
      let total = zeroMoney();

      for (const item of input.lines) {
        const sku = await tx.findSku(item.skuId);
        if (!sku) throw new DomainError('NOT_FOUND', `SKU ${item.skuId} 不存在`, 404);

        /** 行价按量取档：先查阶梯价，无档回落 PriceList 现行价 */
        const { price } = await resolveUnitPrice(tx, sku.id, item.quantity);

        total = addMoney(total, multiplyMoney(price, item.quantity));
        lines.push({
          id: randomUUID(),
          skuId: sku.id,
          quantity: item.quantity,
          receivedQty: 0,
          unitPrice: price,
        });
      }

      const order: PurchaseOrder = {
        id: randomUUID(),
        tenantId: TENANT_ID,
        orderNo: nextDocNo('PO'),
        supplierId: supplier.id,
        status: 'draft',
        lines,
        total,
        rejectReason: null,
        createdAt: new Date().toISOString(),
      };
      await tx.savePurchaseOrder(order);
      return order;
    });
  }

  async submitPurchaseOrder(id: string): Promise<PurchaseOrder> {
    const order = await this.requirePurchaseOrder(id);
    assertPurchaseTransition(order.status, 'submitted');
    order.status = 'submitted';
    await this.db.savePurchaseOrder(order);
    return order;
  }

  /**
   * 审核通过：只允许 submitted → approved。
   * 第 8 批审批流：有启用的采购单门槛规则、订单总额 ≥ 门槛、审批人无 admin 角色 → 403。
   */
  async approvePurchaseOrder(id: string, roles: string[] = []): Promise<PurchaseOrder> {
    const order = await this.requirePurchaseOrder(id);
    assertPurchaseTransition(order.status, 'approved');
    const rules = await this.db.listApprovalRules();
    const rule = rules.find((r) => r.docType === 'purchase_order' && r.enabled);
    if (rule && order.total.amount >= rule.thresholdAmount.amount && !roles.includes('admin')) {
      throw new DomainError(
        'FORBIDDEN',
        `订单金额 ¥${(order.total.amount / 100).toFixed(2)} ≥ ¥${(rule.thresholdAmount.amount / 100).toFixed(2)}，需管理员审批`,
        403,
      );
    }
    order.status = 'approved';
    await this.db.savePurchaseOrder(order);
    return order;
  }

  /** 驳回：原因必填（无原因 400），落库到 rejectReason；只允许 submitted → rejected */
  async rejectPurchaseOrder(id: string, reason: string): Promise<PurchaseOrder> {
    const order = await this.requirePurchaseOrder(id);
    if (!reason?.trim()) {
      throw new DomainError('INVALID_STATE', '驳回原因不能为空', 400);
    }
    assertPurchaseTransition(order.status, 'rejected');
    order.status = 'rejected';
    order.rejectReason = reason.trim();
    await this.db.savePurchaseOrder(order);
    return order;
  }

  /**
   * 入库：lines 缺省 = 整单收完（老行为）；传 lines = 按行收指定数量。
   * 每行收到的数量加进批次（无批次新建，batchCode 用采购单号）；receivedQty 累加；
   * 全部行收满 → received，否则 → partially_received；每次入库建一张入库单；同一事务。
   */
  async receivePurchaseOrder(
    id: string,
    input: ReceivePurchaseOrderRequest = {},
  ): Promise<{ order: PurchaseOrder; receipt: GoodsReceipt }> {
    return this.db.runInTransaction(async (tx) => {
      const order = await tx.findPurchaseOrder(id);
      if (!order) throw new DomainError('NOT_FOUND', `采购订单 ${id} 不存在`, 404);
      if (order.status !== 'approved' && order.status !== 'partially_received') {
        throw new DomainError('INVALID_STATE', `采购订单状态 ${order.status} 不允许入库`, 409);
      }

      // 本次要收的行：缺省为全部行收剩余量；传了则逐行校验
      const wanted = new Map<string, number>();
      if (input.lines) {
        for (const item of input.lines) {
          const line = order.lines.find((l) => l.skuId === item.skuId);
          if (!line) throw new DomainError('INVALID_STATE', `采购单里没有该 SKU 的行`, 400);
          const remaining = line.quantity - line.receivedQty;
          // 同一 SKU 在 body 里出现多次时按累计量校验，不能只按单条校验
          const accumulated = (wanted.get(item.skuId) ?? 0) + item.quantity;
          if (accumulated > remaining) {
            throw new DomainError('CONFLICT', `SKU ${item.skuId} 本次入库 ${accumulated} 件超过剩余 ${remaining} 件`, 409);
          }
          wanted.set(item.skuId, accumulated);
        }
      } else {
        for (const line of order.lines) {
          const remaining = line.quantity - line.receivedQty;
          if (remaining > 0) wanted.set(line.skuId, remaining);
        }
      }
      if (wanted.size === 0) {
        throw new DomainError('INVALID_STATE', '没有可入库的行（已全部收满）', 409);
      }

      const receiptLines: GoodsReceipt['lines'] = [];
      for (const line of order.lines) {
        const qty = wanted.get(line.skuId);
        if (!qty) continue;
        const lot = await tx.findLotBySku(line.skuId);
        let batchCode: string;
        if (lot) {
          lot.availableQty += qty;
          lot.totalQty += qty;
          await tx.saveLot(lot);
          batchCode = lot.batchCode;
        } else {
          batchCode = order.orderNo;
          await tx.saveLot({
            id: randomUUID(),
            tenantId: TENANT_ID,
            skuId: line.skuId,
            batchCode,
            location: DEFAULT_LOCATION,
            availableQty: qty,
            reservedQty: 0,
            totalQty: qty,
          });
        }
        line.receivedQty += qty;
        receiptLines.push({ id: randomUUID(), skuId: line.skuId, quantity: qty, batchCode });
      }

      const allReceived = order.lines.every((l) => l.receivedQty >= l.quantity);
      order.status = allReceived ? 'received' : 'partially_received';
      await tx.savePurchaseOrder(order);

      const now = new Date().toISOString();
      const receipt: GoodsReceipt = {
        id: randomUUID(),
        tenantId: TENANT_ID,
        receiptNo: nextDocNo('GRN'),
        purchaseOrderId: order.id,
        orderNo: order.orderNo,
        lines: receiptLines,
        receivedAt: now,
        createdAt: now,
      };
      await tx.saveReceipt(receipt);
      return { order, receipt };
    });
  }

  async cancelPurchaseOrder(id: string): Promise<PurchaseOrder> {
    const order = await this.requirePurchaseOrder(id);
    assertPurchaseTransition(order.status, 'cancelled');
    order.status = 'cancelled';
    await this.db.savePurchaseOrder(order);
    return order;
  }

  private async requirePurchaseOrder(id: string): Promise<PurchaseOrder> {
    const order = await this.db.findPurchaseOrder(id);
    if (!order) throw new DomainError('NOT_FOUND', `采购订单 ${id} 不存在`, 404);
    return order;
  }
}
