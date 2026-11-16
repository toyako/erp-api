import { Injectable } from '@nestjs/common';
import { CreateCustomerRequestSchema, type ImportResult } from '@erp/contracts';
import { parseCsv } from '../domain/csv';
import { DatabasePort, DomainError } from '../domain/ports';
import { CustomerService } from './customer.service';
import { StocktakeService } from './stocktake.service';

/**
 * CSV 导入（第 8 批）：客户导入与盘点批量导入共用一套机制。
 * 单行坏不影响整批：created 成功、skipped 可预期跳过（编码已存在）、errors 需人工修。
 * 行号从 2 开始算（第 1 行是表头）。
 */
@Injectable()
export class ImportService {
  constructor(
    private readonly db: DatabasePort,
    private readonly customers: CustomerService,
    private readonly stocktakes: StocktakeService,
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
}
