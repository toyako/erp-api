import { describe, expect, it, beforeEach } from 'vitest';
import { CustomerService } from '../src/application/customer.service';
import { ImportService } from '../src/application/import.service';
import { StocktakeService } from '../src/application/stocktake.service';
import { InMemoryDatabase } from '../src/infrastructure/in-memory.database';

describe('第 8 批：CSV 导入（客户 + 盘点批量）', () => {
  let db: InMemoryDatabase;
  let importer: ImportService;

  beforeEach(() => {
    db = new InMemoryDatabase();
    importer = new ImportService(db, new CustomerService(db), new StocktakeService(db));
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
