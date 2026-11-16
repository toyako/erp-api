import { STOCKTAKE_TRANSITIONS, type StocktakeStatus } from '@erp/contracts';
import { canTransition } from './state-machine';
import { DomainError } from './ports';

export function assertStocktakeTransition(from: StocktakeStatus, to: StocktakeStatus): void {
  if (!canTransition(STOCKTAKE_TRANSITIONS, from, to)) {
    throw new DomainError(
      'INVALID_STATE',
      `盘点单状态 ${from} 不允许迁移到 ${to}`,
      409,
    );
  }
}
