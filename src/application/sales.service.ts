import { Injectable } from '@nestjs/common';
import { addMoney, multiplyMoney, zeroMoney } from '../domain/money';
import { randomUUID } from 'node:crypto';
import type {
  CreateOrderRequest,
  OrderLine,
  SalesOrder,
} from '@erp/contracts';
import { DatabasePort, DomainError, PaymentGatewayPort } from '../domain/ports';
import { assertTransition } from '../domain/order-state';

export const TENANT_ID = '00000000-0000-4000-8000-000000000001';

@Injectable()
export class SalesService {
  constructor(
    private readonly db: DatabasePort,
    private readonly payment: PaymentGatewayPort,
  ) {}

  listOrders() {
    return this.db.listOrders();
  }

  /** 金额只由服务端按价格表计算，请求体不含任何金额字段 */
  async createOrder(input: CreateOrderRequest): Promise<SalesOrder> {
    return this.db.runInTransaction(async (tx) => {
      const lines: OrderLine[] = [];
      let total = zeroMoney();

      for (const item of input.lines) {
        const sku = await tx.findSku(item.skuId);
        if (!sku) throw new DomainError('NOT_FOUND', `SKU ${item.skuId} 不存在`, 404);

        const price = await tx.findPriceBySku(sku.id);
        if (!price) throw new DomainError('NOT_FOUND', `SKU ${sku.id} 未定价`, 404);

        const lot = await tx.findLotBySku(sku.id);
        if (!lot || lot.availableQty < item.quantity) {
          throw new DomainError('INSUFFICIENT_STOCK', `SKU ${sku.id} 可用库存不足`, 409);
        }

        lot.availableQty -= item.quantity;
        lot.reservedQty += item.quantity;
        await tx.saveLot(lot);

        total = addMoney(total, multiplyMoney(price.price, item.quantity));
        lines.push({
          id: randomUUID(),
          skuId: sku.id,
          quantity: item.quantity,
          unitPrice: price.price,
        });
      }

      const order: SalesOrder = {
        id: randomUUID(),
        tenantId: TENANT_ID,
        orderNo: `ERP-${Date.now().toString(36).toUpperCase()}`,
        status: 'confirmed',
        lines,
        total,
        createdAt: new Date().toISOString(),
      };
      await tx.saveOrder(order);
      return order;
    });
  }

  async payOrder(id: string): Promise<SalesOrder> {
    const order = await this.requireOrder(id);
    assertTransition(order.status, 'paid');
    await this.payment.charge({
      orderId: order.id,
      amount: order.total.amount,
      currency: order.total.currency,
    });
    order.status = 'paid';
    await this.db.saveOrder(order);
    return order;
  }

  async fulfillOrder(id: string): Promise<SalesOrder> {
    const order = await this.requireOrder(id);
    assertTransition(order.status, 'fulfilled');
    order.status = 'fulfilled';
    await this.db.saveOrder(order);
    return order;
  }

  private async requireOrder(id: string): Promise<SalesOrder> {
    const order = await this.db.findOrder(id);
    if (!order) throw new DomainError('NOT_FOUND', `订单 ${id} 不存在`, 404);
    return order;
  }
}
