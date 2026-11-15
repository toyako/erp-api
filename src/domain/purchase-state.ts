import { PURCHASE_ORDER_TRANSITIONS, type PurchaseOrderStatus } from '@erp/contracts';
import { canTransition } from './state-machine';
import { DomainError } from './ports';

export function assertPurchaseTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus): void {
  if (!canTransition(PURCHASE_ORDER_TRANSITIONS, from, to)) {
    throw new DomainError(
      'INVALID_STATE',
      `采购订单状态 ${from} 不允许迁移到 ${to}`,
      409,
    );
  }
}
