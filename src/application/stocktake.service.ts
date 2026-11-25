import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  CreateStocktakeRequest,
  PageQueryParams,
  Stocktake,
} from '@erp/contracts';
import { DatabasePort, DomainError } from '../domain/ports';
import { nextDocNo } from '../domain/doc-no';
import { assertStocktakeTransition } from '../domain/stocktake-state';
import { TENANT_ID } from './sales.service';

@Injectable()
export class StocktakeService {
  constructor(private readonly db: DatabasePort) {}

  listStocktakes(params: PageQueryParams) {
    return this.db.listStocktakes(params);
  }

  async findStocktake(id: string): Promise<Stocktake> {
    const found = await this.db.findStocktake(id);
    if (!found) throw new DomainError('NOT_FOUND', `盘点单 ${id} 不存在`, 404);
    return found;
  }

  /**
   * 建单：按 lotId 取批次，systemQty 为建单时该批次 totalQty 的快照，
   * difference = countedQty - systemQty，服务端算并存下来；建单时不动库存。
   */
  async createStocktake(input: CreateStocktakeRequest): Promise<Stocktake> {
    const lot = await this.db.findLot(input.lotId);
    if (!lot) throw new DomainError('NOT_FOUND', `批次 ${input.lotId} 不存在`, 404);
    const stocktake: Stocktake = {
      id: randomUUID(),
      tenantId: TENANT_ID,
      stocktakeNo: await nextDocNo('STK', (p) => this.db.listStocktakes(p), (s) => s.stocktakeNo),
      lotId: lot.id,
      skuId: lot.skuId,
      countedQty: input.countedQty,
      systemQty: lot.totalQty,
      difference: input.countedQty - lot.totalQty,
      status: 'draft',
      createdAt: new Date().toISOString(),
      confirmedAt: null,
    };
    await this.db.saveStocktake(stocktake);
    return stocktake;
  }

  /**
   * 确认盘点：把差异落到批次上——实盘数为准：总量改为实盘数；
   * 占用不能超过实盘（reserved = min(占用, 实盘)），可用数 = 实盘 − 占用，
   * total = available + reserved 的不变量始终成立。
   * 实盘小于占用时，多占的那部分被释放——订单短缺会在履约时暴露，
   * 而不是留一个总量 < 占用的坏账在库里。
   * 记 confirmedAt；整单同一事务。
   */
  async confirmStocktake(id: string): Promise<Stocktake> {
    return this.db.runInTransaction(async (tx) => {
      const stocktake = await tx.findStocktake(id);
      if (!stocktake) throw new DomainError('NOT_FOUND', `盘点单 ${id} 不存在`, 404);
      assertStocktakeTransition(stocktake.status, 'confirmed');
      const lot = await tx.findLot(stocktake.lotId);
      if (!lot) throw new DomainError('NOT_FOUND', `批次 ${stocktake.lotId} 不存在`, 404);
      lot.reservedQty = Math.min(lot.reservedQty, stocktake.countedQty);
      lot.totalQty = stocktake.countedQty;
      lot.availableQty = stocktake.countedQty - lot.reservedQty;
      await tx.saveLot(lot);
      stocktake.status = 'confirmed';
      stocktake.confirmedAt = new Date().toISOString();
      await tx.saveStocktake(stocktake);
      return stocktake;
    });
  }

  /** 取消：只改状态，不动库存 */
  async cancelStocktake(id: string): Promise<Stocktake> {
    const stocktake = await this.requireStocktake(id);
    assertStocktakeTransition(stocktake.status, 'cancelled');
    stocktake.status = 'cancelled';
    await this.db.saveStocktake(stocktake);
    return stocktake;
  }

  private async requireStocktake(id: string): Promise<Stocktake> {
    const stocktake = await this.db.findStocktake(id);
    if (!stocktake) throw new DomainError('NOT_FOUND', `盘点单 ${id} 不存在`, 404);
    return stocktake;
  }
}
