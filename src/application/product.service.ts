import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  CreatePriceRequest,
  CreateSkuRequest,
  PageQueryParams,
  PriceList,
  Sku,
  UpdatePriceRequest,
} from '@erp/contracts';
import { DatabasePort, DomainError, type Page } from '../domain/ports';
import { TENANT_ID } from './sales.service';

/**
 * 商品与价格档案：SKU 新建（编码查重、SPU 须存在）与价格新建/改价。
 * 价格按 SKU 可有多条（渠道 + 生效窗口）；findPriceBySku 取未截止中生效最晚的一条，
 * 新建一条当前生效的价格即成为定价依据，旧记录不自动截止（生效期规则不在本次范围）。
 */
@Injectable()
export class ProductService {
  constructor(private readonly db: DatabasePort) {}

  listSpus(params: PageQueryParams) {
    return this.db.listSpus(params);
  }

  listPrices(params: PageQueryParams): Promise<Page<PriceList>> {
    return this.db.listPrices(params);
  }

  /** 编码查重用分页循环拉全量，与 CustomerService.collectAllCustomers 同款做法 */
  private async collectAllSkus(): Promise<Sku[]> {
    const all: Sku[] = [];
    let page = 1;
    for (;;) {
      const result = await this.db.listSkus({ page, pageSize: 200 });
      all.push(...result.items);
      if (all.length >= result.total || result.items.length === 0) break;
      page += 1;
    }
    return all;
  }

  async createSku(input: CreateSkuRequest): Promise<Sku> {
    const spu = await this.db.findSpu(input.spuId);
    if (!spu) throw new DomainError('NOT_FOUND', `SPU ${input.spuId} 不存在`, 404);
    const existing = await this.collectAllSkus();
    if (existing.some((s) => s.code === input.code)) {
      throw new DomainError('CONFLICT', `SKU 编码 ${input.code} 已存在`, 409);
    }
    const sku: Sku = {
      id: randomUUID(),
      spuId: input.spuId,
      code: input.code,
      spec: input.spec,
      unit: input.unit,
      enabled: input.enabled ?? true,
    };
    await this.db.saveSku(sku);
    return sku;
  }

  async createPrice(input: CreatePriceRequest): Promise<PriceList> {
    const sku = await this.db.findSku(input.skuId);
    if (!sku) throw new DomainError('NOT_FOUND', `SKU ${input.skuId} 不存在`, 404);
    const price: PriceList = {
      id: randomUUID(),
      skuId: input.skuId,
      channelCode: input.channelCode ?? 'DIRECT',
      price: input.price,
      effectiveFrom: input.effectiveFrom ?? new Date().toISOString(),
    };
    await this.db.savePrice(price);
    return price;
  }

  async updatePrice(id: string, input: UpdatePriceRequest): Promise<PriceList> {
    const found = await this.db.findPrice(id);
    if (!found) throw new DomainError('NOT_FOUND', `价格 ${id} 不存在`, 404);
    if (input.price === undefined && input.effectiveTo === undefined) {
      throw new DomainError('INVALID_STATE', '没有要修改的字段', 400);
    }
    const merged: PriceList = {
      ...found,
      price: input.price ?? found.price,
    };
    // effectiveTo 为 null 表示取消截止（恢复长期有效）；PriceList 的 effectiveTo
    // 是 optional 而非 nullable，null 不能直接存，删键表示“无截止”
    if (input.effectiveTo !== undefined) {
      if (input.effectiveTo === null) delete merged.effectiveTo;
      else merged.effectiveTo = input.effectiveTo;
    }
    await this.db.savePrice(merged);
    return merged;
  }
}
