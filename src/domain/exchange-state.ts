import { EXCHANGE_TRANSITIONS, type ExchangeStatus } from '@erp/contracts';
import { canTransition } from './state-machine';
import { DomainError } from './ports';

export function assertExchangeTransition(from: ExchangeStatus, to: ExchangeStatus): void {
  if (!canTransition(EXCHANGE_TRANSITIONS, from, to)) {
    throw new DomainError(
      'INVALID_STATE',
      `换货单状态 ${from} 不允许迁移到 ${to}`,
      409,
    );
  }
}
