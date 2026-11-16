import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  CreateTransferRequest,
  InventoryLot,
  PageQueryParams,
  Transfer,
} from '@erp/contracts';
import { DatabasePort, DomainError, type Page } from '../domain/ports';
import { nextDocNo } from '../domain/doc-no';
import { assertTransferTransition } from '../domain/transfer-state';
import { TENANT_ID } from './sales.service';

@Injectable()
export class TransferService {
  constructor(private readonly db: DatabasePort) {}

  listTransfers(params: PageQueryParams) {
    return this.db.listTransfers(params);
  }

  async findTransfer(id: string): Promise<Transfer> {
    const found = await this.db.findTransfer(id);
    if (!found) throw new DomainError('NOT_FOUND', `调拨单 ${id} 不存在`, 404);
    return found;
  }

  /** 建单校验：SKU 存在、源库位与目标库位不同、两端都须是已启用的仓库；建单时不扣库存 */
  async createTransfer(input: CreateTransferRequest): Promise<Transfer> {
    if (input.fromLocation === input.toLocation) {
      throw new DomainError('INVALID_STATE', '源库位与目标库位不能相同', 400);
    }
    const sku = await this.db.findSku(input.skuId);
    if (!sku) throw new DomainError('NOT_FOUND', `SKU ${input.skuId} 不存在`, 404);
    for (const location of [input.fromLocation, input.toLocation]) {
      const warehouse = await this.db.findWarehouseByCode(location);
      if (!warehouse || !warehouse.enabled) {
        throw new DomainError('NOT_FOUND', `仓库 ${location} 不存在或已停用`, 400);
      }
    }
    const transfer: Transfer = {
      id: randomUUID(),
      tenantId: TENANT_ID,
      transferNo: nextDocNo('TRF'),
      skuId: input.skuId,
      fromLocation: input.fromLocation,
      toLocation: input.toLocation,
      quantity: input.quantity,
      status: 'draft',
      batchCode: null,
      rejectReason: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    await this.db.saveTransfer(transfer);
    return transfer;
  }

  /** 提交审核：draft → submitted */
  async submitTransfer(id: string): Promise<Transfer> {
    const transfer = await this.requireTransfer(id);
    assertTransferTransition(transfer.status, 'submitted');
    transfer.status = 'submitted';
    await this.db.saveTransfer(transfer);
    return transfer;
  }

  /** 审核通过：submitted → approved */
  async approveTransfer(id: string): Promise<Transfer> {
    const transfer = await this.requireTransfer(id);
    assertTransferTransition(transfer.status, 'approved');
    transfer.status = 'approved';
    await this.db.saveTransfer(transfer);
    return transfer;
  }

  /** 拒绝：原因必填（无原因 400），落库到 rejectReason；只允许 submitted → rejected */
  async rejectTransfer(id: string, reason: string): Promise<Transfer> {
    const transfer = await this.requireTransfer(id);
    if (!reason?.trim()) {
      throw new DomainError('INVALID_STATE', '拒绝原因不能为空', 400);
    }
    assertTransferTransition(transfer.status, 'rejected');
    transfer.status = 'rejected';
    transfer.rejectReason = reason.trim();
    await this.db.saveTransfer(transfer);
    return transfer;
  }

  /**
   * 完成调拨：FIFO 取源库位 batchCode 最小的批次扣数，目标库位同 batchCode 的批次加数，
   * 目标无该批次则新建（batchCode 取源批次）；回填 batchCode 并记 completedAt；整单同一事务。
   */
  async completeTransfer(id: string): Promise<Transfer> {
    return this.db.runInTransaction(async (tx) => {
      const transfer = await tx.findTransfer(id);
      if (!transfer) throw new DomainError('NOT_FOUND', `调拨单 ${id} 不存在`, 404);
      assertTransferTransition(transfer.status, 'completed');
      const lots = await this.collectAllLots(tx);
      const source = lots
        .filter((l) => l.skuId === transfer.skuId && l.location === transfer.fromLocation)
        .sort((a, b) => a.batchCode.localeCompare(b.batchCode))[0];
      if (!source) {
        throw new DomainError('CONFLICT', `源库位 ${transfer.fromLocation} 没有该 SKU 的批次`, 409);
      }
      if (source.availableQty < transfer.quantity) {
        throw new DomainError('CONFLICT', `源批次 ${source.batchCode} 可用 ${source.availableQty} 件，不足 ${transfer.quantity} 件`, 409);
      }
      source.availableQty -= transfer.quantity;
      source.totalQty -= transfer.quantity;
      await tx.saveLot(source);
      const dest = lots.find(
        (l) => l.skuId === transfer.skuId && l.location === transfer.toLocation && l.batchCode === source.batchCode,
      );
      if (dest) {
        dest.availableQty += transfer.quantity;
        dest.totalQty += transfer.quantity;
        await tx.saveLot(dest);
      } else {
        await tx.saveLot({
          id: randomUUID(),
          tenantId: TENANT_ID,
          skuId: transfer.skuId,
          batchCode: source.batchCode,
          location: transfer.toLocation,
          availableQty: transfer.quantity,
          reservedQty: 0,
          totalQty: transfer.quantity,
        });
      }
      transfer.status = 'completed';
      transfer.batchCode = source.batchCode;
      transfer.completedAt = new Date().toISOString();
      await tx.saveTransfer(transfer);
      return transfer;
    });
  }

  /** 取消：只改状态，不动库存 */
  async cancelTransfer(id: string): Promise<Transfer> {
    const transfer = await this.requireTransfer(id);
    assertTransferTransition(transfer.status, 'cancelled');
    transfer.status = 'cancelled';
    await this.db.saveTransfer(transfer);
    return transfer;
  }

  /** 找批用：分页循环拉全量批次，与 DashboardService 同款做法 */
  private async collectAllLots(db: DatabasePort): Promise<InventoryLot[]> {
    const all: InventoryLot[] = [];
    let page = 1;
    for (;;) {
      const result: Page<InventoryLot> = await db.listLots({ page, pageSize: 200 });
      all.push(...result.items);
      if (all.length >= result.total || result.items.length === 0) break;
      page += 1;
    }
    return all;
  }

  private async requireTransfer(id: string): Promise<Transfer> {
    const transfer = await this.db.findTransfer(id);
    if (!transfer) throw new DomainError('NOT_FOUND', `调拨单 ${id} 不存在`, 404);
    return transfer;
  }
}
