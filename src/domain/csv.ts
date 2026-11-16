/**
 * 最小 CSV 解析/生成（导入导出共用）：处理 BOM、\r\n、引号内逗号与双引号转义、空行跳过。
 * 不引第三方库；客户导入与盘点批量导入都走它。
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  const pushField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const pushRow = () => {
    pushField();
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (!fieldStarted && field === '') {
        inQuotes = true;
        fieldStarted = true;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === ',') {
      pushField();
      continue;
    }
    if (ch === '\n') {
      pushRow();
      continue;
    }
    if (ch === '\r') {
      if (src[i + 1] === '\n') i++;
      pushRow();
      continue;
    }
    field += ch;
    fieldStarted = true;
  }
  if (field !== '' || fieldStarted || row.length > 0) pushRow();
  return rows;
}

/** 导出用：含逗号/引号/换行时加引号并转义引号 */
export function toCsvRow(values: (string | number | null | undefined)[]): string {
  return values
    .map((v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(',');
}
