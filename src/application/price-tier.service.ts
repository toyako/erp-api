import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  CreatePriceTierRequest,
  PageQueryParams,
  PriceTier,
  ResolvePriceResult,
  UpdatePriceTierRequest,
} from '@erp/contracts';
import { DatabasePort, DomainError } from '../domain/ports';
import { DEFAULT_CHANNEL, resolveUnitPrice } from '../domain/pricing';
import { TENANT_ID } from './sales.service';

@Injectable()
export class PriceTierService {
  constructor(private readonly db: DatabasePort) {}

  listPriceTiers(params: PageQueryParams, skuId?: string) {
    return this.db.listPriceTiers(params, skuId ? { skuId } : undefined);
  }

  async resolvePrice(skuId: string, quantity: number, channelCode: string = DEFAULT_CHANNEL): Promise<ResolvePriceResult> {
    const sku = await this.db.findSku(skuId);
    if (!sku) throw new DomainError('NOT_FOUND', `SKU ${skuId} 不存在`, 404);
    const { price, tier } = await resolveUnitPrice(this.db, skuId, quantity, channelCode);
    return { skuId, quantity, tier, price };
  }

  async createPriceTier(input: CreatePriceTierRequest): Promise<PriceTier> {
    const sku = await this.db.findSku(input.skuId);
    if (!sku) throw new DomainError('NOT_FOUND', `SKU ${input.skuId} 不存在`, 404);
    const channelCode = input.channelCode ?? DEFAULT_CHANNEL;
    await this.assertMinQtyUnique(input.skuId, channelCode, input.minQty);
    const tier: PriceTier = {
      id: randomUUID(),
      tenantId: TENANT_ID,
      skuId: input.skuId,
      channelCode,
      minQty: input.minQty,
      price: input.price,
      enabled: true,
    };
    await this.db.savePriceTier(tier);
    return tier;
  }

  async updatePriceTier(id: string, input: UpdatePriceTierRequest): Promise<PriceTier> {
    const tier = await this.requireTier(id);
    const nextMinQty = input.minQty ?? tier.minQty;
    if (nextMinQty !== tier.minQty) {
      await this.assertMinQtyUnique(tier.skuId, tier.channelCode, nextMinQty, id);
    }
    if (input.minQty !== undefined) tier.minQty = input.minQty;
    if (input.price !== undefined) tier.price = input.price;
    if (input.enabled !== undefined) tier.enabled = input.enabled;
    await this.db.savePriceTier(tier);
    return tier;
  }

  async deletePriceTier(id: string): Promise<void> {
    await this.requireTier(id);
    await this.db.deletePriceTier(id);
  }

  private async assertMinQtyUnique(skuId: string, channelCode: string, minQty: number, exceptId?: string): Promise<void> {
    const list = await this.db.listPriceTiers({ page: 1, pageSize: 1000 }, { skuId });
    if (list.items.some((t) => t.channelCode === channelCode && t.minQty === minQty && t.id !== exceptId)) {
      throw new DomainError('CONFLICT', `该 SKU 在渠道 ${channelCode} 下已有起订量 ${minQty} 的阶梯价`, 409);
    }
  }

  private async requireTier(id: string): Promise<PriceTier> {
    const tier = await this.db.findPriceTier(id);
    if (!tier) throw new DomainError('NOT_FOUND', `阶梯价 ${id} 不存在`, 404);
    return tier;
  }
}
