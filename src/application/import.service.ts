import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  CreateCustomerRequestSchema,
  CreateSkuRequestSchema,
  CreateSupplierRequestSchema,
  type ImportResult,
  type Spu,
  type Supplier,
} from '@erp/contracts';
import { parseCsv } from '../domain/csv';
import { DatabasePort, DomainError } from '../domain/ports';
import { CustomerService } from './customer.service';
import { ProductService } from './product.service';
import { TENANT_ID } from './sales.service';
import { StocktakeService } from './stocktake.service';

/**
 * CSV 导入：客户与盘点（第 8 批）、商品与供应商（Excel 导入，xlsx 由前端解析后转 CSV 再上传）
 * 共用一套机制。单行坏不影响整批：created 成功、skipped 可预期跳过（编码已存在）、errors 需人工修。
 * 行号从 2 开始算（第 1 行是表头）。
 */
@Injectable()
export class ImportService {
  constructor(
    private readonly db: DatabasePort,
    private readonly customers: CustomerService,
    private readonly stocktakes: StocktakeService,
    private readonly products: ProductService,
  ) {}

  /** 客户导入：表头 code,name,phone,level */
  async importCustomers(buffer: Buffer): Promise<ImportResult> {
    const rows = parseCsv(buffer.toString('utf-8'));
    const result: ImportResult = { created: 0, skipped: [], errors: [] };
    const dataRows = rows.slice(1);
    for (let i = 0; i < dataRows.length; i++) {
      const rowNo = i + 2;
      const [code = '', name = '', phone = '', level = ''] = dataRows[i] ?? [];
      const parsed = CreateCustomerRequestSchema.safeParse({
        code: code.trim(),
        name: name.trim(),
        phone: phone.trim() || undefined,
        level: level.trim() || 'regular',
      });
      if (!parsed.success) {
        result.errors.push({ row: rowNo, reason: parsed.error.issues[0]?.message ?? '行格式错误' });
        continue;
      }
      try {
        await this.customers.createCustomer(parsed.data);
        result.created += 1;
      } catch (e) {
        if (e instanceof DomainError && e.code === 'CONFLICT') {
          result.skipped.push({ row: rowNo, reason: `编码 ${parsed.data.code} 已存在` });
        } else {
          result.errors.push({ row: rowNo, reason: e instanceof Error ? e.message : '导入失败' });
        }
      }
    }
    return result;
  }

  /** 盘点批量导入：表头 batchCode,countedQty；按批次号建草稿盘点单 */
  async importStocktakes(buffer: Buffer): Promise<ImportResult> {
    const rows = parseCsv(buffer.toString('utf-8'));
    const result: ImportResult = { created: 0, skipped: [], errors: [] };
    const seen = new Set<string>();
    const dataRows = rows.slice(1);
    for (let i = 0; i < dataRows.length; i++) {
      const rowNo = i + 2;
      const [batchCode = '', countedQtyRaw = ''] = dataRows[i] ?? [];
      const code = batchCode.trim();
      if (!code) {
        result.errors.push({ row: rowNo, reason: '批次号为空' });
        continue;
      }
      if (seen.has(code)) {
        result.errors.push({ row: rowNo, reason: `批次 ${code} 在文件里重复` });
        continue;
      }
      seen.add(code);
      const countedQty = Number(countedQtyRaw.trim());
      if (!Number.isInteger(countedQty) || countedQty < 0) {
        result.errors.push({ row: rowNo, reason: '实盘数须为非负整数' });
        continue;
      }
      const lot = await this.db.findLotByBatchCode(code);
      if (!lot) {
        result.errors.push({ row: rowNo, reason: `批次 ${code} 不存在` });
        continue;
      }
      try {
        await this.stocktakes.createStocktake({ lotId: lot.id, countedQty });
        result.created += 1;
      } catch (e) {
        result.errors.push({ row: rowNo, reason: e instanceof Error ? e.message : '导入失败' });
      }
    }
    return result;
  }

  private async collectAllSpus(): Promise<Spu[]> {
    const all: Spu[] = [];
    let page = 1;
    for (;;) {
      const result = await this.db.listSpus({ page, pageSize: 200 });
      all.push(...result.items);
      if (all.length >= result.total || result.items.length === 0) break;
      page += 1;
    }
    return all;
  }

  private async collectAllSuppliers(): Promise<Supplier[]> {
    const all: Supplier[] = [];
    let page = 1;
    for (;;) {
      const result = await this.db.listSuppliers({ page, pageSize: 200 });
      all.push(...result.items);
      if (all.length >= result.total || result.items.length === 0) break;
      page += 1;
    }
    return all;
  }

  /**
   * 商品导入：表头 spuName,code,spec,unit,price。
   * SPU 按名称查（须已存在，不自动建）；price 为可选售价（元），有则建一条 DIRECT 渠道价格。
   * 成本价不导入：新建 SKU 的成本本就为空（与手工新建一致，另行维护）。
   */
  async importProducts(buffer: Buffer): Promise<ImportResult> {
    const rows = parseCsv(buffer.toString('utf-8'));
    const result: ImportResult = { created: 0, skipped: [], errors: [] };
    const spus = await this.collectAllSpus();
    const spuByName = new Map<string, Spu>();
    for (const spu of spus) {
      if (!spuByName.has(spu.name)) spuByName.set(spu.name, spu);
    }
    const dataRows = rows.slice(1);
    for (let i = 0; i < dataRows.length; i++) {
      const rowNo = i + 2;
      const [spuName = '', code = '', spec = '', unit = '', priceRaw = ''] = dataRows[i] ?? [];
      const spu = spuByName.get(spuName.trim());
      if (!spu) {
        result.errors.push({ row: rowNo, reason: `SPU ${spuName.trim() || '（空）'} 不存在，请先在商品管理新建 SPU` });
        continue;
      }
      const parsed = CreateSkuRequestSchema.safeParse({
        spuId: spu.id,
        code: code.trim(),
        spec: spec.trim(),
        unit: unit.trim(),
      });
      if (!parsed.success) {
        result.errors.push({ row: rowNo, reason: parsed.error.issues[0]?.message ?? '行格式错误' });
        continue;
      }
      const priceText = priceRaw.trim();
      let priceCents: number | null = null;
      if (priceText !== '') {
        if (!/^\d+(\.\d{1,2})?$/.test(priceText) || Number(priceText) <= 0) {
          result.errors.push({ row: rowNo, reason: '售价须为正数（元，最多两位小数）' });
          continue;
        }
        priceCents = Math.round(Number(priceText) * 100);
      }
      try {
        const sku = await this.products.createSku(parsed.data);
        if (priceCents !== null) {
          await this.products.createPrice({
            skuId: sku.id,
            channelCode: 'DIRECT',
            price: { amount: priceCents, currency: 'CNY' },
          });
        }
        result.created += 1;
      } catch (e) {
        if (e instanceof DomainError && e.code === 'CONFLICT') {
          result.skipped.push({ row: rowNo, reason: `SKU 编码 ${parsed.data.code} 已存在` });
        } else {
          result.errors.push({ row: rowNo, reason: e instanceof Error ? e.message : '导入失败' });
        }
      }
    }
    return result;
  }

  /**
   * 供应商导入：表头 code,name,contact,phone,rating；rating 为空默认 3 分。
   * 编码查重在导入层做（手工新建的 controller 不查重，saveSupplier 本是 upsert）。
   */
  async importSuppliers(buffer: Buffer): Promise<ImportResult> {
    const rows = parseCsv(buffer.toString('utf-8'));
    const result: ImportResult = { created: 0, skipped: [], errors: [] };
    const codes = new Set((await this.collectAllSuppliers()).map((s) => s.code));
    const dataRows = rows.slice(1);
    for (let i = 0; i < dataRows.length; i++) {
      const rowNo = i + 2;
      const [codeRaw = '', name = '', contact = '', phone = '', ratingRaw = ''] = dataRows[i] ?? [];
      const ratingText = ratingRaw.trim();
      const parsed = CreateSupplierRequestSchema.safeParse({
        code: codeRaw.trim(),
        name: name.trim(),
        contact: contact.trim() || undefined,
        phone: phone.trim() || undefined,
        rating: ratingText === '' ? undefined : Number(ratingText),
      });
      if (!parsed.success) {
        result.errors.push({ row: rowNo, reason: parsed.error.issues[0]?.message ?? '行格式错误' });
        continue;
      }
      if (codes.has(parsed.data.code)) {
        result.skipped.push({ row: rowNo, reason: `编码 ${parsed.data.code} 已存在` });
        continue;
      }
      const supplier: Supplier = {
        id: randomUUID(),
        tenantId: TENANT_ID,
        code: parsed.data.code,
        name: parsed.data.name,
        ...(parsed.data.contact ? { contact: parsed.data.contact } : {}),
        ...(parsed.data.phone ? { phone: parsed.data.phone } : {}),
        rating: parsed.data.rating,
        enabled: true,
      };
      await this.db.saveSupplier(supplier);
      codes.add(parsed.data.code);
      result.created += 1;
    }
    return result;
  }
}
