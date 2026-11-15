import { ORDER_TRANSITIONS, type OrderStatus } from '@erp/contracts';
import { canTransition } from './state-machine';
import { DomainError } from './ports';

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(ORDER_TRANSITIONS, from, to)) {
    throw new DomainError(
      'INVALID_STATE',
      `订单状态 ${from} 不允许迁移到 ${to}`,
      409,
    );
  }
}
