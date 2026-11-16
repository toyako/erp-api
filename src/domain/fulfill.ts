import type { SalesOrder } from '@erp/contracts';
import type { DatabasePort } from './ports';

/**
 * 履约扣数（SalesService.fulfillOrder 与 ShipmentService.shipShipment 共用）：
 * 每行从该 SKU 的批次扣 min(数量, 占用量)，占用与总量同减，可用量不变。
 * 调用方负责在同一事务内改订单状态；只扣数，不改状态。
 */
export async function deductReservedForOrder(tx: DatabasePort, order: SalesOrder): Promise<void> {
  for (const line of order.lines) {
    const lot = await tx.findLotBySku(line.skuId);
    if (!lot) continue;
    const consumed = Math.min(line.quantity, lot.reservedQty);
    lot.reservedQty -= consumed;
    lot.totalQty -= consumed;
    await tx.saveLot(lot);
  }
}
