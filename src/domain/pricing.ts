import type { Money, PriceTier } from '@erp/contracts';
import type { DatabasePort } from './ports';
import { DomainError } from './ports';

/** 渠道默认 DIRECT（与 PriceList 定价口径一致） */
export const DEFAULT_CHANNEL = 'DIRECT';

/**
 * 阶梯取价：先查满足 minQty ≤ 数量的已启用档中 minQty 最大的一条；
 * 无档回落到 PriceList 现行价；都没定价则 404。
 */
export async function resolveUnitPrice(
  db: DatabasePort,
  skuId: string,
  quantity: number,
  channelCode: string = DEFAULT_CHANNEL,
): Promise<{ price: Money; tier: PriceTier | null }> {
  const tier = await db.findBestPriceTier(skuId, quantity, channelCode);
  if (tier) return { price: tier.price, tier };
  const list = await db.findPriceBySku(skuId);
  if (!list) throw new DomainError('NOT_FOUND', `SKU ${skuId} 未定价`, 404);
  return { price: list.price, tier: null };
}
