import { Injectable } from '@nestjs/common';
import { addMoney, multiplyMoney, zeroMoney } from '../domain/money';
import { randomUUID } from 'node:crypto';
import { DEFAULT_LOCATION } from '@erp/contracts';
import type {
  CreatePurchaseOrderRequest,
  PageQueryParams,
  PurchaseOrder,
  PurchaseOrderLine,
} from '@erp/contracts';
import { DatabasePort, DomainError } from '../domain/ports';
import { assertPurchaseTransition } from '../domain/purchase-state';
import { TENANT_ID } from './sales.service';

@Injectable()
export class PurchaseService {
  constructor(private readonly db: DatabasePort) {}

  listPurchaseOrders(params: PageQueryParams) {
    return this.db.listPurchaseOrders(params);
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

        const price = await tx.findPriceBySku(sku.id);
        if (!price) throw new DomainError('NOT_FOUND', `SKU ${sku.id} 未定价`, 404);

        total = addMoney(total, multiplyMoney(price.price, item.quantity));
        lines.push({
          id: randomUUID(),
          skuId: sku.id,
          quantity: item.quantity,
          unitPrice: price.price,
        });
      }

      const order: PurchaseOrder = {
        id: randomUUID(),
        tenantId: TENANT_ID,
        orderNo: `PO-${Date.now().toString(36).toUpperCase()}`,
        supplierId: supplier.id,
        status: 'draft',
        lines,
        total,
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

  /** 入库：逐行把数量加进批次；无批次的 SKU 新建批次（batchCode 用采购单号）。整单放进同一事务 */
  async receivePurchaseOrder(id: string): Promise<PurchaseOrder> {
    return this.db.runInTransaction(async (tx) => {
      const order = await tx.findPurchaseOrder(id);
      if (!order) throw new DomainError('NOT_FOUND', `采购订单 ${id} 不存在`, 404);
      assertPurchaseTransition(order.status, 'received');
      for (const line of order.lines) {
        const lot = await tx.findLotBySku(line.skuId);
        if (lot) {
          lot.availableQty += line.quantity;
          lot.totalQty += line.quantity;
          await tx.saveLot(lot);
        } else {
          await tx.saveLot({
            id: randomUUID(),
            tenantId: TENANT_ID,
            skuId: line.skuId,
            batchCode: order.orderNo,
            location: DEFAULT_LOCATION,
            availableQty: line.quantity,
            reservedQty: 0,
            totalQty: line.quantity,
          });
        }
      }
      order.status = 'received';
      await tx.savePurchaseOrder(order);
      return order;
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
