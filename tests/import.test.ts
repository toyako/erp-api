import { describe, expect, it, beforeEach } from 'vitest';
import { CustomerService } from '../src/application/customer.service';
import { ImportService } from '../src/application/import.service';
import { ProductService } from '../src/application/product.service';
import { StocktakeService } from '../src/application/stocktake.service';
import { InMemoryDatabase } from '../src/infrastructure/in-memory.database';

describe('第 8 批：CSV 导入（客户 + 盘点批量）', () => {
  let db: InMemoryDatabase;
  let importer: ImportService;

  beforeEach(() => {
    db = new InMemoryDatabase();
    importer = new ImportService(db, new CustomerService(db), new StocktakeService(db), new ProductService(db));
  });

  it('客户导入：建 1 条、编码重复跳 1 条、空编码错 1 条，单行坏不影响整批', async () => {
    const csv = [
      'code,name,phone,level',
      'CUST-101,新客户甲,13800000001,regular',
      'CUST-101,重复编码,13800000002,regular',
      ',无编码,13800000003,regular',
    ].join('\n');
    const result = await importer.importCustomers(Buffer.from(csv, 'utf-8'));
    expect(result.created).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ row: 3, reason: '编码 CUST-101 已存在' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(4);
    const customers = await db.listCustomers({ page: 1, pageSize: 20 });
    expect(customers.items.some((c) => c.code === 'CUST-101' && c.name === '新客户甲')).toBe(true);
  });

  it('客户导入：非法等级报错；只有表头时 0 条无错', async () => {
    const bad = await importer.importCustomers(Buffer.from('code,name,phone,level\nCUST-102,乙,138,gold\n', 'utf-8'));
    expect(bad.created).toBe(0);
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0].row).toBe(2);
    const empty = await importer.importCustomers(Buffer.from('code,name,phone,level\n', 'utf-8'));
    expect(empty).toEqual({ created: 0, skipped: [], errors: [] });
  });

  it('盘点批量导入：建 1 张草稿单（systemQty 快照 100、difference −2）、批次不存在错、文件内重复错、非整数错', async () => {
    const csv = [
      'batchCode,countedQty',
      'BATCH-001,98',
      'BATCH-999,10',
      'BATCH-001,99',
      'BATCH-002,abc',
    ].join('\n');
    const result = await importer.importStocktakes(Buffer.from(csv, 'utf-8'));
    expect(result.created).toBe(1);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(3);
    expect(result.errors.map((e) => e.row)).toEqual([3, 4, 5]);
    const stocktakes = await db.listStocktakes({ page: 1, pageSize: 20 });
    const created = stocktakes.items.find((s) => s.stocktakeNo !== 'STK-DEMO-001');
    expect(created).toMatchObject({ countedQty: 98, systemQty: 100, difference: -2, status: 'draft' });
  });
});

describe('Excel 导入（商品 + 供应商）：xlsx 由前端解析后转 CSV 再走同一批接口', () => {
  let db: InMemoryDatabase;
  let importer: ImportService;

  beforeEach(() => {
    db = new InMemoryDatabase();
    importer = new ImportService(db, new CustomerService(db), new StocktakeService(db), new ProductService(db));
  });

  it('商品导入：带售价建 1 条并建价格档案、无售价建 1 条、SPU 不存在错、编码重复跳、售价非法错', async () => {
    const csv = [
      'spuName,code,spec,unit,price',
      '云智物标准套件,SKU-IMP-01,标准版,套,299',
      '云智物标准套件,SKU-IMP-02,专业版,套,',
      '不存在的SPU,SKU-IMP-03,标准版,套,199',
      '云智物标准套件,SKU-001,标准版,套,199',
      '云智物标准套件,SKU-IMP-04,标准版,套,abc',
    ].join('\n');
    const result = await importer.importProducts(Buffer.from(csv, 'utf-8'));
    expect(result.created).toBe(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ row: 5, reason: 'SKU 编码 SKU-001 已存在' });
    expect(result.errors.map((e) => e.row)).toEqual([4, 6]);
    const skus = await db.listSkus({ page: 1, pageSize: 20 });
    const created = skus.items.find((s) => s.code === 'SKU-IMP-01');
    expect(created).toMatchObject({ spec: '标准版', unit: '套' });
    const prices = await db.listPrices({ page: 1, pageSize: 20 });
    expect(prices.items.find((p) => p.skuId === created!.id)).toMatchObject({
      channelCode: 'DIRECT',
      price: { amount: 29900, currency: 'CNY' },
    });
    expect(prices.items.some((p) => skus.items.find((s) => s.code === 'SKU-IMP-02' && s.id === p.skuId))).toBe(false);
  });

  it('供应商导入：建 2 条（评级为空默认 3 分）、编码重复跳、评级非法错、空编码错', async () => {
    const csv = [
      'code,name,contact,phone,rating',
      'SUP-IMP-01,示例供应商甲,张三,13800000001,4',
      'SUP-IMP-01,重复编码,李四,13800000002,3',
      'SUP-IMP-02,默认评级,,,',
      'SUP-IMP-03,评级非法,,,9',
      ',无编码,,,3',
    ].join('\n');
    const result = await importer.importSuppliers(Buffer.from(csv, 'utf-8'));
    expect(result.created).toBe(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ row: 3, reason: '编码 SUP-IMP-01 已存在' });
    expect(result.errors.map((e) => e.row)).toEqual([5, 6]);
    const suppliers = await db.listSuppliers({ page: 1, pageSize: 20 });
    expect(suppliers.items.find((s) => s.code === 'SUP-IMP-01')).toMatchObject({ name: '示例供应商甲', rating: 4 });
    expect(suppliers.items.find((s) => s.code === 'SUP-IMP-02')).toMatchObject({ rating: 3, enabled: true });
  });
});
