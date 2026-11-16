import type { CustomerLevel, LevelRule } from '@erp/contracts';

/**
 * 等级判定（纯函数）：取 minSpent ≤ 累计消费的规则中门槛最高者；
 * 门槛相同时后者胜出（规则按门槛升序排列，等于高等级优先）；
 * 无规则时默认普通。
 */
export function resolveLevel(totalSpentAmount: number, rules: LevelRule[]): CustomerLevel {
  let level: CustomerLevel = 'regular';
  let best = -1;
  for (const rule of rules) {
    if (rule.minSpent.amount <= totalSpentAmount && rule.minSpent.amount >= best) {
      best = rule.minSpent.amount;
      level = rule.level;
    }
  }
  return level;
}
