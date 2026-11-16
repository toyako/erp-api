import { describe, expect, it } from 'vitest';
import { parseCsv, toCsvRow } from '../src/domain/csv';

describe('CSV 解析/生成（第 8 批导入导出）', () => {
  it('表头 + 两行正常解析', () => {
    expect(parseCsv('code,name,phone\nCUST-001,甲,138\nCUST-002,乙,')).toEqual([
      ['code', 'name', 'phone'],
      ['CUST-001', '甲', '138'],
      ['CUST-002', '乙', ''],
    ]);
  });

  it('引号内逗号与双引号转义', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
  });

  it('BOM 与 CRLF 与空行跳过', () => {
    expect(parseCsv('\uFEFFa,b\r\n1,2\r\n\r\n3,4\r\n')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('引号内换行保留', () => {
    expect(parseCsv('a,b\n"x\ny",2')).toEqual([['a', 'b'], ['x\ny', '2']]);
  });

  it('toCsvRow：含逗号/引号时加引号并转义', () => {
    expect(toCsvRow(['a', 'x, y', 'say "hi"', 5, null])).toBe('a,"x, y","say ""hi""",5,');
  });
});
