import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { ExchangeService } from '../src/application/exchange.service';
import { RmaService } from '../src/application/rma.service';
import { SalesService } from '../src/application/sales.service';
import { InMemoryDatabase } from '../src/infrastructure/in-memory.database';
import { MockPaymentGateway } from '../src/infrastructure/mock-payment.gateway';

const SKU1 = '00000000-0000-4000-8000-000000000101';
const SKU2 = '00000000-0000-4000-8000-000000000102';

/** InMemory 种子价：SKU-001 ¥199、SKU-002 ¥299；BATCH-001 100 件、BATCH-002 50 件 */
describe('第 8 批：换货流程', () => {
  let db: InMemoryDatabase;
  let sales: SalesService;
  let rma: RmaService;
  let exchange: ExchangeService;

  beforeEach(() => {
    db = new InMemoryDatabase();
    sales = new SalesService(db, new MockPaymentGateway());
    rma = new RmaService(db);
    exchange = new ExchangeService(db);
  });

  async function fulfilledOrder(skuId: string, quantity: number) {
    const order = await sales.createOrder({ lines: [{ skuId, quantity }] });
    await sales.confirmOrder(order.id);
    await sales.payOrder(order.id);
    return sales.fulfillOrder(order.id);
  }

  async function lotBySku(skuId: string) {
    const lots = await db.listLots({ page: 1, pageSize: 20 });
    return lots.items.find((l) => l.skuId === skuId);
  }

  it('建单：差价服务端算（换入 ¥299 − 退货 ¥199 = +¥100），状态 requested', async () => {
    const order = await fulfilledOrder(SKU1, 1);
    const exc = await exchange.createExchange({ orderId: order.id, returnSkuId: SKU1, returnQty: 1, exchangeSkuId: SKU2, exchangeQty: 1 });
    expect(exc.status).toBe('requested');
    expect(exc.exchangeNo.startsWith('EXC-')).toBe(true);
    expect(exc.diffAmount).toEqual({ amount: 10000, currency: 'CNY' });
    expect(exc.rejectReason).toBeNull();
  });

  it('建单校验：未发货订单 409、超可退余量 409、换入 SKU 不存在 404', async () => {
    const draft = await sales.createOrder({ lines: [{ skuId: SKU1, quantity: 1 }] });
    await expect(exchange.createExchange({ orderId: draft.id, returnSkuId: SKU1, returnQty: 1, exchangeSkuId: SKU2, exchangeQty: 1 })).rejects.toMatchObject({ status: 409 });
    const order = await fulfilledOrder(SKU1, 1);
    await expect(exchange.createExchange({ orderId: order.id, returnSkuId: SKU1, returnQty: 2, exchangeSkuId: SKU2, exchangeQty: 1 })).rejects.toMatchObject({ status: 409 });
    await expect(exchange.createExchange({ orderId: order.id, returnSkuId: SKU1, returnQty: 1, exchangeSkuId: randomUUID(), exchangeQty: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(exchange.createExchange({ orderId: order.id, returnSkuId: SKU2, returnQty: 1, exchangeSkuId: SKU2, exchangeQty: 1 })).rejects.toMatchObject({ status: 400 });
  });

  it('换货与退货共享可退余量：已审核的退货占掉余量后，换货建单 409', async () => {
    const order = await fulfilledOrder(SKU1, 1);
    const r = await rma.createRma({ orderId: order.id, skuId: SKU1, quantity: 1, reason: '退货' });
    await rma.approveRma(r.id);
    await expect(exchange.createExchange({ orderId: order.id, returnSkuId: SKU1, returnQty: 1, exchangeSkuId: SKU2, exchangeQty: 1 })).rejects.toMatchObject({ status: 409 });
  });

  it('全链路：审核 → 收货回补库存（BATCH-001 99→100）→ 完成换货扣新 SKU（BATCH-002 50→49）', async () => {
    const order = await fulfilledOrder(SKU1, 1);
    expect((await lotBySku(SKU1))?.totalQty).toBe(99);
    const exc = await exchange.createExchange({ orderId: order.id, returnSkuId: SKU1, returnQty: 1, exchangeSkuId: SKU2, exchangeQty: 1 });
    await exchange.approveExchange(exc.id);
    const received = await exchange.receiveExchange(exc.id);
    expect(received.status).toBe('received');
    expect(received.receivedAt).not.toBeNull();
    expect((await lotBySku(SKU1))?.totalQty).toBe(100);
    const done = await exchange.completeExchange(exc.id);
    expect(done.status).toBe('exchanged');
    expect(done.exchangedAt).not.toBeNull();
    expect((await lotBySku(SKU2))?.totalQty).toBe(49);
    expect((await lotBySku(SKU2))?.availableQty).toBe(49);
  });

  it('完成换货时换入 SKU 库存不足 409', async () => {
    const order = await fulfilledOrder(SKU1, 1);
    const exc = await exchange.createExchange({ orderId: order.id, returnSkuId: SKU1, returnQty: 1, exchangeSkuId: SKU2, exchangeQty: 100 });
    await exchange.approveExchange(exc.id);
    await exchange.receiveExchange(exc.id);
    await expect(exchange.completeExchange(exc.id)).rejects.toMatchObject({ status: 409 });
  });

  it('驳回：空原因 400、原因落库、终态不可再审', async () => {
    const order = await fulfilledOrder(SKU1, 1);
    const exc = await exchange.createExchange({ orderId: order.id, returnSkuId: SKU1, returnQty: 1, exchangeSkuId: SKU2, exchangeQty: 1 });
    await expect(exchange.rejectExchange(exc.id, '')).rejects.toMatchObject({ status: 400 });
    const rejected = await exchange.rejectExchange(exc.id, '商品已拆封');
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectReason).toBe('商品已拆封');
    await expect(exchange.approveExchange(exc.id)).rejects.toMatchObject({ status: 409 });
  });
});
