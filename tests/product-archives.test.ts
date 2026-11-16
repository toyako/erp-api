import { describe, expect, it, beforeEach } from 'vitest';
import { CategoryService } from '../src/application/category.service';
import { PriceTierService } from '../src/application/price-tier.service';
import { WarehouseService } from '../src/application/warehouse.service';
import { SalesService } from '../src/application/sales.service';
import { InMemoryDatabase } from '../src/infrastructure/in-memory.database';
import { MockPaymentGateway } from '../src/infrastructure/mock-payment.gateway';

const SKU1 = '00000000-0000-4000-8000-000000000101';
const SKU2 = '00000000-0000-4000-8000-000000000102';

describe('第 6 批：商品与档案深化', () => {
  let db: InMemoryDatabase;
  let category: CategoryService;
  let tier: PriceTierService;
  let warehouse: WarehouseService;
  let sales: SalesService;

  beforeEach(() => {
    db = new InMemoryDatabase();
    category = new CategoryService(db);
    tier = new PriceTierService(db);
    warehouse = new WarehouseService(db);
    sales = new SalesService(db, new MockPaymentGateway());
  });

  it('分类树：种子为根“软件”下挂两个子分类', async () => {
    const tree = await category.listTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].code).toBe('SOFTWARE');
    expect(tree[0].children.map((c) => c.code)).toEqual(['SOFTWARE-STD', 'SOFTWARE-PRO']);
  });

  it('分类：建子分类、code 查重 409、父分类不存在 404', async () => {
    const root = await category.createCategory({ code: 'MAT', name: '耗材' });
    const child = await category.createCategory({ code: 'MAT-WIRE', name: '线材', parentId: root.id });
    expect(child.parentId).toBe(root.id);
    await expect(category.createCategory({ code: 'MAT', name: '重复' })).rejects.toMatchObject({ status: 409 });
    await expect(category.createCategory({ code: 'X', name: 'x', parentId: '00000000-0000-4000-8000-000000000099' })).rejects.toMatchObject({ status: 404 });
  });

  it('分类：成环 400（把父级挂到子孙下）', async () => {
    const root = await category.createCategory({ code: 'A', name: 'A' });
    const child = await category.createCategory({ code: 'B', name: 'B', parentId: root.id });
    await expect(category.updateCategory(root.id, { parentId: child.id })).rejects.toMatchObject({ status: 400 });
    await expect(category.updateCategory(root.id, { parentId: root.id })).rejects.toMatchObject({ status: 400 });
  });

  it('分类：删有子分类 409；删掉两个子分类后，删根分类因 SPU 引用 409；删无引用的叶子成功', async () => {
    await expect(category.deleteCategory('00000000-0000-4000-8000-000000000603')).rejects.toMatchObject({ status: 409 });
    const tree = await category.listTree();
    for (const child of tree[0].children) {
      await category.deleteCategory(child.id);
    }
    // 子分类已删净，但种子 SPU 的 categoryCode 是 'SOFTWARE'，仍应被引用校验拦住
    await expect(category.deleteCategory('00000000-0000-4000-8000-000000000603')).rejects.toMatchObject({ status: 409 });
    const leaf = await category.createCategory({ code: 'LEAF', name: '叶子' });
    await category.deleteCategory(leaf.id);
    const after = await category.listTree();
    expect(after[0].children).toHaveLength(0);
  });

  it('阶梯价：10 件取 10 档、5 件取 5 档、1 件回落现行价 ¥199（内存种子价）', async () => {
    await tier.createPriceTier({ skuId: SKU1, minQty: 5, price: { amount: 19900, currency: 'CNY' } });
    await tier.createPriceTier({ skuId: SKU1, minQty: 10, price: { amount: 18900, currency: 'CNY' } });
    const r10 = await tier.resolvePrice(SKU1, 10);
    expect(r10.price.amount).toBe(18900);
    expect(r10.tier?.minQty).toBe(10);
    const r5 = await tier.resolvePrice(SKU1, 5);
    expect(r5.price.amount).toBe(19900);
    const r1 = await tier.resolvePrice(SKU1, 1);
    expect(r1.price.amount).toBe(19900);
    expect(r1.tier).toBeNull();
  });

  it('阶梯价：同 SKU 同渠道同 minQty 重复 409、改档改 minQty 撞档 409', async () => {
    await tier.createPriceTier({ skuId: SKU1, minQty: 5, price: { amount: 19900, currency: 'CNY' } });
    await expect(tier.createPriceTier({ skuId: SKU1, minQty: 5, price: { amount: 19000, currency: 'CNY' } })).rejects.toMatchObject({ status: 409 });
    const t10 = await tier.createPriceTier({ skuId: SKU1, minQty: 10, price: { amount: 18900, currency: 'CNY' } });
    await expect(tier.updatePriceTier(t10.id, { minQty: 5 })).rejects.toMatchObject({ status: 409 });
  });

  it('阶梯价：建单行价按量取档（10 件 ¥189）', async () => {
    await tier.createPriceTier({ skuId: SKU1, minQty: 10, price: { amount: 18900, currency: 'CNY' } });
    const order = await sales.createOrder({ lines: [{ skuId: SKU1, quantity: 10 }] });
    expect(order.total.amount).toBe(189000);
    expect(order.lines[0].unitPrice.amount).toBe(18900);
  });

  it('仓库：种子有主仓/华东仓；新建 code 查重 409；停用有批次引用 409', async () => {
    const list = await warehouse.listWarehouses({ page: 1, pageSize: 10 });
    expect(list.items.map((w) => w.code)).toEqual(['主仓', '华东仓']);
    await expect(warehouse.createWarehouse({ code: '主仓', name: '重复' })).rejects.toMatchObject({ status: 409 });
    const main = list.items.find((w) => w.code === '主仓')!;
    await expect(warehouse.updateWarehouse(main.id, { enabled: false })).rejects.toMatchObject({ status: 409 });
    const nw = await warehouse.createWarehouse({ code: '南仓', name: '南仓' });
    const off = await warehouse.updateWarehouse(nw.id, { enabled: false });
    expect(off.enabled).toBe(false);
  });
});
