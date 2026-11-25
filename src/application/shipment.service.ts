import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  CreateShipmentRequest,
  PageQueryParams,
  Shipment,
  ShipShipmentRequest,
} from '@erp/contracts';
import { DatabasePort, DomainError, type Page } from '../domain/ports';
import { nextDocNo } from '../domain/doc-no';
import { deductReservedForOrder } from '../domain/fulfill';
import { assertShipmentTransition } from '../domain/shipment-state';
import { TENANT_ID } from './sales.service';

@Injectable()
export class ShipmentService {
  constructor(private readonly db: DatabasePort) {}

  listShipments(params: PageQueryParams): Promise<Page<Shipment>> {
    return this.db.listShipments(params);
  }

  async findShipment(id: string): Promise<Shipment> {
    const found = await this.db.findShipment(id);
    if (!found) throw new DomainError('NOT_FOUND', `发货单 ${id} 不存在`, 404);
    return found;
  }

  /**
   * 建单校验：订单存在且为 paid（已付款才发货）；行照抄订单行（batchCode 拣货时回填）。
   * 一单一单（v1 不做一单多发）：同一订单已有未取消的发货单时报 409。
   */
  async createShipment(input: CreateShipmentRequest): Promise<Shipment> {
    return this.db.runInTransaction(async (tx) => {
      const order = await tx.findOrder(input.orderId);
      if (!order) throw new DomainError('NOT_FOUND', `订单 ${input.orderId} 不存在`, 404);
      if (order.status !== 'paid') {
        throw new DomainError('INVALID_STATE', `订单 ${order.orderNo} 未付款（当前 ${order.status}），不能发货`, 409);
      }
      const existing = (await this.collectAllShipments(tx)).find(
        (s) => s.orderId === order.id && s.status !== 'cancelled',
      );
      if (existing) {
        throw new DomainError('CONFLICT', `订单 ${order.orderNo} 已有发货单 ${existing.shipmentNo}`, 409);
      }
      const shipment: Shipment = {
        id: randomUUID(),
        tenantId: TENANT_ID,
        shipmentNo: await nextDocNo('SHP', (p) => tx.listShipments(p), (s) => s.shipmentNo),
        orderId: order.id,
        orderNo: order.orderNo,
        status: 'draft',
        lines: order.lines.map((l) => ({ skuId: l.skuId, quantity: l.quantity, batchCode: null })),
        carrier: null,
        trackingNo: null,
        createdAt: new Date().toISOString(),
        shippedAt: null,
        deliveredAt: null,
      };
      await tx.saveShipment(shipment);
      return shipment;
    });
  }

  /**
   * 拣货：回填每行的 batchCode——取履约扣数的同一批次（findLotBySku），
   * 与发货时 deductReservedForOrder 扣的批次一致，不另搞 FIFO。
   */
  async pickShipment(id: string): Promise<Shipment> {
    return this.db.runInTransaction(async (tx) => {
      const shipment = await tx.findShipment(id);
      if (!shipment) throw new DomainError('NOT_FOUND', `发货单 ${id} 不存在`, 404);
      assertShipmentTransition(shipment.status, 'picking');
      for (const line of shipment.lines) {
        const lot = await tx.findLotBySku(line.skuId);
        line.batchCode = lot ? lot.batchCode : null;
      }
      shipment.status = 'picking';
      await tx.saveShipment(shipment);
      return shipment;
    });
  }

  async packShipment(id: string): Promise<Shipment> {
    const shipment = await this.requireShipment(id);
    assertShipmentTransition(shipment.status, 'packed');
    shipment.status = 'packed';
    await this.db.saveShipment(shipment);
    return shipment;
  }

  /**
   * 发货：承运商与物流单号必填；订单仍为 paid 时联动履约（同一事务内扣库存、订单变 fulfilled），
   * 订单已是 fulfilled（走过独立履约口）时只改发货单状态，不重复扣库存。
   */
  async shipShipment(id: string, input: ShipShipmentRequest): Promise<Shipment> {
    return this.db.runInTransaction(async (tx) => {
      const shipment = await tx.findShipment(id);
      if (!shipment) throw new DomainError('NOT_FOUND', `发货单 ${id} 不存在`, 404);
      assertShipmentTransition(shipment.status, 'shipped');
      const order = await tx.findOrder(shipment.orderId);
      if (!order) throw new DomainError('NOT_FOUND', `订单 ${shipment.orderId} 不存在`, 404);
      if (order.status === 'paid') {
        await deductReservedForOrder(tx, order);
        order.status = 'fulfilled';
        await tx.saveOrder(order);
      } else if (order.status !== 'fulfilled') {
        throw new DomainError('INVALID_STATE', `订单 ${order.orderNo} 当前 ${order.status}，不能发货`, 409);
      }
      shipment.status = 'shipped';
      shipment.carrier = input.carrier.trim();
      shipment.trackingNo = input.trackingNo.trim();
      shipment.shippedAt = new Date().toISOString();
      await tx.saveShipment(shipment);
      return shipment;
    });
  }

  async deliverShipment(id: string): Promise<Shipment> {
    const shipment = await this.requireShipment(id);
    assertShipmentTransition(shipment.status, 'delivered');
    shipment.status = 'delivered';
    shipment.deliveredAt = new Date().toISOString();
    await this.db.saveShipment(shipment);
    return shipment;
  }

  /** 取消只取消发货单，不动订单（订单仍为 paid，可重建发货单或走独立履约） */
  async cancelShipment(id: string): Promise<Shipment> {
    const shipment = await this.requireShipment(id);
    assertShipmentTransition(shipment.status, 'cancelled');
    shipment.status = 'cancelled';
    await this.db.saveShipment(shipment);
    return shipment;
  }

  private async requireShipment(id: string): Promise<Shipment> {
    const found = await this.db.findShipment(id);
    if (!found) throw new DomainError('NOT_FOUND', `发货单 ${id} 不存在`, 404);
    return found;
  }

  private async collectAllShipments(tx: DatabasePort): Promise<Shipment[]> {
    const out: Shipment[] = [];
    let page = 1;
    for (;;) {
      const res = await tx.listShipments({ page, pageSize: 200 });
      out.push(...res.items);
      if (out.length >= res.total || res.items.length === 0) break;
      page += 1;
    }
    return out;
  }
}
