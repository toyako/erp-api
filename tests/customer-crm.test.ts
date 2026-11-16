import { describe, expect, it, beforeEach } from 'vitest';
import { CustomerService } from '../src/application/customer.service';
import { DashboardService } from '../src/application/dashboard.service';
import { SalesService } from '../src/application/sales.service';
import { resolveLevel } from '../src/domain/level-rules';
import { InMemoryDatabase } from '../src/infrastructure/in-memory.database';
import { MockPaymentGateway } from '../src/infrastructure/mock-payment.gateway';

const SKU1 = '00000000-0000-4000-8000-000000000101';

describe('第 7 批：客户深化（余额 + 等级规则 + 跟进）', () => {
  let db: InMemoryDatabase;
  let customers: CustomerService;
  let sales: SalesService;
  let dashboard: DashboardService;

  beforeEach(() => {
    db = new InMemoryDatabase();
    customers = new CustomerService(db);
    sales = new SalesService(db, new MockPaymentGateway());
    dashboard = new DashboardService(db);
  });

  it('等级规则种子：普通 ¥0 / VIP ¥1000，且 resolveLevel 按门槛取最高', async () => {
    const rules = await customers.listLevelRules();
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => [r.level, r.minSpent.amount])).toEqual([['regular', 0], ['vip', 100000]]);
    expect(resolveLevel(0, rules)).toBe('regular');
    expect(resolveLevel(99999, rules)).toBe('regular');
    expect(resolveLevel(100000, rules)).toBe('vip');
    expect(resolveLevel(0, [])).toBe('regular');
  });

  it('充值：余额增加并记 topup 流水；不存在的客户 404', async () => {
    const c = await customers.createCustomer({ code: 'CUST-001', name: '甲' });
    expect(c.balance).toEqual({ amount: 0, currency: 'CNY' });
    const after = await customers.topupCustomer(c.id, { amount: { amount: 50000, currency: 'CNY' }, remark: '预存' });
    expect(after.balance).toEqual({ amount: 50000, currency: 'CNY' });
    const txs = await customers.listBalanceTransactions(c.id, { page: 1, pageSize: 20 });
    expect(txs.total).toBe(1);
    expect(txs.items[0]).toMatchObject({ kind: 'topup', amount: { amount: 50000, currency: 'CNY' }, balanceAfter: { amount: 50000, currency: 'CNY' }, remark: '预存' });
    await expect(customers.topupCustomer('00000000-0000-4000-8000-000000000099', { amount: { amount: 100, currency: 'CNY' } })).rejects.toMatchObject({ status: 404 });
  });

  it('余额支付：扣款 + 记 consume 流水 + 订单变已付款；余额不足 409 且订单仍待收款；无客户订单 400', async () => {
    const c = await customers.createCustomer({ code: 'CUST-001', name: '甲' });
    await customers.topupCustomer(c.id, { amount: { amount: 50000, currency: 'CNY' } });
    // InMemory 种子 SKU-001 售价 ¥199
    const order = await sales.createOrder({ lines: [{ skuId: SKU1, quantity: 1 }], customerId: c.id });
    await sales.confirmOrder(order.id);
    const paid = await sales.payOrder(order.id, { useBalance: true });
    expect(paid.status).toBe('paid');
    const after = await customers.findCustomer(c.id);
    expect(after.balance).toEqual({ amount: 30100, currency: 'CNY' });
    const txs = await customers.listBalanceTransactions(c.id, { page: 1, pageSize: 20 });
    expect(txs.total).toBe(2);
    expect(txs.items.map((t) => t.kind).sort()).toEqual(['consume', 'topup']);
    const consume = txs.items.find((t) => t.kind === 'consume');
    expect(consume).toMatchObject({ amount: { amount: 19900, currency: 'CNY' }, balanceAfter: { amount: 30100, currency: 'CNY' } });

    const big = await sales.createOrder({ lines: [{ skuId: SKU1, quantity: 2 }], customerId: c.id });
    await sales.confirmOrder(big.id);
    await expect(sales.payOrder(big.id, { useBalance: true })).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE', status: 409 });
    const still = (await sales.listOrders({ page: 1, pageSize: 20 })).items.find((o) => o.id === big.id);
    expect(still?.status).toBe('confirmed');

    const noCustomer = await sales.createOrder({ lines: [{ skuId: SKU1, quantity: 1 }] });
    await sales.confirmOrder(noCustomer.id);
    await expect(sales.payOrder(noCustomer.id, { useBalance: true })).rejects.toMatchObject({ status: 400 });
  });

  it('等级自动升降级：建单累计过门槛升 VIP，取消回落普通；改门槛后重评按新门槛', async () => {
    const c = await customers.createCustomer({ code: 'CUST-001', name: '甲' });
    const order = await sales.createOrder({ lines: [{ skuId: SKU1, quantity: 6 }], customerId: c.id });
    const up = await customers.reevaluateLevel(c.id);
    expect(up?.level).toBe('vip');
    await sales.cancelOrder(order.id);
    const down = await customers.reevaluateLevel(c.id);
    expect(down?.level).toBe('regular');
    // 门槛改为 ¥100 后，¥199 的累计即达 VIP
    await customers.updateLevelRule('vip', { minSpent: { amount: 10000, currency: 'CNY' } });
    const order2 = await sales.createOrder({ lines: [{ skuId: SKU1, quantity: 1 }], customerId: c.id });
    const up2 = await customers.reevaluateLevel(c.id);
    expect(up2?.level).toBe('vip');
    await sales.cancelOrder(order2.id);
    await customers.updateLevelRule('vip', { minSpent: { amount: 100000, currency: 'CNY' } });
    const down2 = await customers.reevaluateLevel(c.id);
    expect(down2?.level).toBe('regular');
    await expect(customers.updateLevelRule('gold', { minSpent: { amount: 1, currency: 'CNY' } })).rejects.toMatchObject({ status: 400 });
  });

  it('跟进：新建/列表/标记完成；不存在的客户 404；空改 400；到期进待办、完成后消失', async () => {
    const c = await customers.createCustomer({ code: 'CUST-001', name: '甲' });
    const past = new Date(Date.now() - 3600_000).toISOString();
    const f = await customers.createFollowup(c.id, { content: '下周回访谈续费', nextAt: past });
    expect(f.done).toBe(false);
    const list = await customers.listFollowups(c.id, { page: 1, pageSize: 20 });
    expect(list.total).toBe(1);
    const todos = await dashboard.listTodos({ page: 1, pageSize: 20, type: 'followup' });
    expect(todos.total).toBe(1);
    expect(todos.items[0]).toMatchObject({ type: 'followup', typeLabel: '跟进', refNo: 'CUST-001', done: false, action: '去跟进' });
    const done = await customers.updateFollowup(f.id, { done: true });
    expect(done.done).toBe(true);
    const todosAfter = await dashboard.listTodos({ page: 1, pageSize: 20, type: 'followup' });
    expect(todosAfter.total).toBe(0);
    await expect(customers.createFollowup('00000000-0000-4000-8000-000000000099', { content: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(customers.updateFollowup(f.id, {})).rejects.toMatchObject({ status: 400 });
  });

  it('跟进：无下次时间的不进待办；未来的不进待办', async () => {
    const c = await customers.createCustomer({ code: 'CUST-001', name: '甲' });
    await customers.createFollowup(c.id, { content: '无时间' });
    await customers.createFollowup(c.id, { content: '未来', nextAt: new Date(Date.now() + 86400_000).toISOString() });
    const todos = await dashboard.listTodos({ page: 1, pageSize: 20, type: 'followup' });
    expect(todos.total).toBe(0);
  });
});
