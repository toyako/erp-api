import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  CreateInvoiceRequest,
  Invoice,
  PageQueryParams,
} from '@erp/contracts';
import { DatabasePort, DomainError, type Page } from '../domain/ports';
import { nextDocNo } from '../domain/doc-no';
import { assertInvoiceTransition } from '../domain/invoice-state';
import { TENANT_ID } from './sales.service';

/** 占可开票额度的状态：草稿与已开票；已作废 / 已取消不占 */
const COUNTED_STATUSES: readonly Invoice['status'][] = ['draft', 'issued'];

@Injectable()
export class InvoiceService {
  constructor(private readonly db: DatabasePort) {}

  listInvoices(params: PageQueryParams): Promise<Page<Invoice>> {
    return this.db.listInvoices(params);
  }

  async findInvoice(id: string): Promise<Invoice> {
    const found = await this.db.findInvoice(id);
    if (!found) throw new DomainError('NOT_FOUND', `发票 ${id} 不存在`, 404);
    return found;
  }

  /**
   * 建单校验：订单存在且为 paid / fulfilled（已收款才开票）；金额 > 0（Zod 已拦 0，
   * 服务端再拦一次防直调）；币种须与订单一致；累计（草稿+已开票）不超过订单总额。
   * 抬头：建单时可填，不填默认订单客户名，无客户时为“散客”。
   */
  async createInvoice(input: CreateInvoiceRequest): Promise<Invoice> {
    return this.db.runInTransaction(async (tx) => {
      const order = await tx.findOrder(input.orderId);
      if (!order) throw new DomainError('NOT_FOUND', `订单 ${input.orderId} 不存在`, 404);
      if (order.status !== 'paid' && order.status !== 'fulfilled') {
        throw new DomainError('INVALID_STATE', `订单 ${order.orderNo} 未收款（当前 ${order.status}），不能开票`, 409);
      }
      if (input.amount.amount <= 0) {
        throw new DomainError('INVALID_STATE', '开票金额必须大于 0', 400);
      }
      if (input.amount.currency !== order.total.currency) {
        throw new DomainError('INVALID_STATE', `币种须与订单一致（${order.total.currency}）`, 400);
      }
      const used = (await this.collectAllInvoices(tx))
        .filter((i) => i.orderId === order.id && COUNTED_STATUSES.includes(i.status))
        .reduce((n, i) => n + i.amount.amount, 0);
      const remaining = order.total.amount - used;
      if (input.amount.amount > remaining) {
        throw new DomainError('CONFLICT', `可开票额度不足（剩余 ¥${(remaining / 100).toFixed(2)}）`, 409);
      }
      let title = input.title?.trim();
      if (!title) {
        if (order.customerId) {
          const customer = await tx.findCustomer(order.customerId);
          title = customer ? customer.name : '散客';
        } else {
          title = '散客';
        }
      }
      const invoice: Invoice = {
        id: randomUUID(),
        tenantId: TENANT_ID,
        invoiceNo: nextDocNo('INV'),
        orderId: order.id,
        orderNo: order.orderNo,
        customerId: order.customerId ?? null,
        amount: input.amount,
        type: input.type ?? 'vat_normal',
        title,
        status: 'draft',
        createdAt: new Date().toISOString(),
        issuedAt: null,
      };
      await tx.saveInvoice(invoice);
      return invoice;
    });
  }

  /** 开票：只记 issuedAt，不对接真实税控（演示系统无税控接口） */
  async issueInvoice(id: string): Promise<Invoice> {
    const invoice = await this.requireInvoice(id);
    assertInvoiceTransition(invoice.status, 'issued');
    invoice.status = 'issued';
    invoice.issuedAt = new Date().toISOString();
    await this.db.saveInvoice(invoice);
    return invoice;
  }

  /** 作废：金额释放回可开额度（作废态不占额度） */
  async voidInvoice(id: string): Promise<Invoice> {
    const invoice = await this.requireInvoice(id);
    assertInvoiceTransition(invoice.status, 'voided');
    invoice.status = 'voided';
    await this.db.saveInvoice(invoice);
    return invoice;
  }

  async cancelInvoice(id: string): Promise<Invoice> {
    const invoice = await this.requireInvoice(id);
    assertInvoiceTransition(invoice.status, 'cancelled');
    invoice.status = 'cancelled';
    await this.db.saveInvoice(invoice);
    return invoice;
  }

  private async requireInvoice(id: string): Promise<Invoice> {
    const found = await this.db.findInvoice(id);
    if (!found) throw new DomainError('NOT_FOUND', `发票 ${id} 不存在`, 404);
    return found;
  }

  private async collectAllInvoices(tx: DatabasePort): Promise<Invoice[]> {
    const out: Invoice[] = [];
    let page = 1;
    for (;;) {
      const res = await tx.listInvoices({ page, pageSize: 200 });
      out.push(...res.items);
      if (out.length >= res.total || res.items.length === 0) break;
      page += 1;
    }
    return out;
  }
}
