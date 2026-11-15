import type { Money } from '@erp/contracts';

/** 金额一律用最小货币单位整数运算，禁止浮点 */
export function multiplyMoney(price: Money, quantity: number): Money {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('quantity must be a positive integer');
  }
  return { amount: price.amount * quantity, currency: price.currency };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error('currency mismatch');
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function zeroMoney(currency = 'CNY'): Money {
  return { amount: 0, currency };
}
