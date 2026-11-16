import { SHIPMENT_TRANSITIONS, type ShipmentStatus } from '@erp/contracts';
import { canTransition } from './state-machine';
import { DomainError } from './ports';

export function assertShipmentTransition(from: ShipmentStatus, to: ShipmentStatus): void {
  if (!canTransition(SHIPMENT_TRANSITIONS, from, to)) {
    throw new DomainError(
      'INVALID_STATE',
      `发货单状态 ${from} 不允许迁移到 ${to}`,
      409,
    );
  }
}
