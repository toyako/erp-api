import { TRANSFER_TRANSITIONS, type TransferStatus } from '@erp/contracts';
import { canTransition } from './state-machine';
import { DomainError } from './ports';

export function assertTransferTransition(from: TransferStatus, to: TransferStatus): void {
  if (!canTransition(TRANSFER_TRANSITIONS, from, to)) {
    throw new DomainError(
      'INVALID_STATE',
      `调拨单状态 ${from} 不允许迁移到 ${to}`,
      409,
    );
  }
}
