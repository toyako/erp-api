import { Injectable } from '@nestjs/common';
import { addMoney, multiplyMoney, zeroMoney } from '../domain/money';
import { randomUUID } from 'node:crypto';
import type {
  CreateOrderRequest,
  OrderLine,
  PageQueryParams,
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

  listOrders(params: PageQueryParams) {
    return this.db.listOrders(params);
  }

  /** 金额只由服务端按价格表计算，请求体不含任何金额字段；customerId 传了则校验客户存在 */
  async createOrder(input: CreateOrderRequest): Promise<SalesOrder> {
    return this.db.runInTransaction(async (tx) => {
      let customerId: string | undefined;
      if (input.customerId) {
        const customer = await tx.findCustomer(input.customerId);
        if (!customer) throw new DomainError('NOT_FOUND', `客户 ${input.customerId} 不存在`, 404);
        customerId = customer.id;
      }

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
        ...(customerId ? { customerId } : {}),
        status: 'draft',
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

  /** 履约：出库扣减——占用量转出库，总量减少，可用量不变（整单同一事务） */
  async fulfillOrder(id: string): Promise<SalesOrder> {
    return this.db.runInTransaction(async (tx) => {
      const order = await tx.findOrder(id);
      if (!order) throw new DomainError('NOT_FOUND', `订单 ${id} 不存在`, 404);
      assertTransition(order.status, 'fulfilled');
      for (const line of order.lines) {
        const lot = await tx.findLotBySku(line.skuId);
        if (!lot) continue;
        const consumed = Math.min(line.quantity, lot.reservedQty);
        lot.reservedQty -= consumed;
        lot.totalQty -= consumed;
        await tx.saveLot(lot);
      }
      order.status = 'fulfilled';
      await tx.saveOrder(order);
      return order;
    });
  }

  /** 草稿单确认：draft -> confirmed，库存已在建单时占用，此处只改状态 */
  async confirmOrder(id: string): Promise<SalesOrder> {
    const order = await this.requireOrder(id);
    assertTransition(order.status, 'confirmed');
    order.status = 'confirmed';
    await this.db.saveOrder(order);
    return order;
  }

  /** 取消：仅 draft / confirmed 可取消（ORDER_TRANSITIONS 已定义），paid 不可；取消释放占用库存回可用量，总量不变（整单同一事务） */
  async cancelOrder(id: string): Promise<SalesOrder> {
    return this.db.runInTransaction(async (tx) => {
      const order = await tx.findOrder(id);
      if (!order) throw new DomainError('NOT_FOUND', `订单 ${id} 不存在`, 404);
      assertTransition(order.status, 'cancelled');
      for (const line of order.lines) {
        const lot = await tx.findLotBySku(line.skuId);
        if (!lot) continue;
        const released = Math.min(line.quantity, lot.reservedQty);
        lot.reservedQty -= released;
        lot.availableQty += released;
        await tx.saveLot(lot);
      }
      order.status = 'cancelled';
      await tx.saveOrder(order);
      return order;
    });
  }

  private async requireOrder(id: string): Promise<SalesOrder> {
    const order = await this.db.findOrder(id);
    if (!order) throw new DomainError('NOT_FOUND', `订单 ${id} 不存在`, 404);
    return order;
  }
}
