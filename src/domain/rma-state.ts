import { RMA_TRANSITIONS, type RmaStatus } from '@erp/contracts';
import { canTransition } from './state-machine';
import { DomainError } from './ports';

export function assertRmaTransition(from: RmaStatus, to: RmaStatus): void {
  if (!canTransition(RMA_TRANSITIONS, from, to)) {
    throw new DomainError(
      'INVALID_STATE',
      `退货单状态 ${from} 不允许迁移到 ${to}`,
      409,
    );
  }
}
