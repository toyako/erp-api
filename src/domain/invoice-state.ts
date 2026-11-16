import { INVOICE_TRANSITIONS, type InvoiceStatus } from '@erp/contracts';
import { canTransition } from './state-machine';
import { DomainError } from './ports';

export function assertInvoiceTransition(from: InvoiceStatus, to: InvoiceStatus): void {
  if (!canTransition(INVOICE_TRANSITIONS, from, to)) {
    throw new DomainError(
      'INVALID_STATE',
      `发票状态 ${from} 不允许迁移到 ${to}`,
      409,
    );
  }
}
