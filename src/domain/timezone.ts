/**
 * 租户时区（纯函数，无新依赖）：
 * 演示租户是中国用户，汇总口径按 Asia/Shanghai 自然日切分。
 * Tenant 表目前没有 timezone 字段（prisma/schema.prisma），先用常量；
 * 以后要做多租户/可配置时区时，把 TENANT_TIMEZONE 换成从租户读时区。
 * 存储不动：单据 createdAt 仍是 UTC ISO，只改汇总时“属于哪一天”的口径。
 */
export const TENANT_TIMEZONE = 'Asia/Shanghai';

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

function part(timeZone: string, t: number, type: string): number {
  const p = dtf(timeZone)
    .formatToParts(new Date(t))
    .find((x) => x.type === type);
  return Number(p?.value);
}

/** 某时区在某瞬间相对 UTC 的偏移毫秒（东正西负） */
export function tzOffsetMs(timeZone: string, t: number): number {
  const asUTC = Date.UTC(
    part(timeZone, t, 'year'),
    part(timeZone, t, 'month') - 1,
    part(timeZone, t, 'day'),
    part(timeZone, t, 'hour'),
    part(timeZone, t, 'minute'),
    part(timeZone, t, 'second'),
  );
  return asUTC - t;
}

/** 某个瞬间在某时区的日期 'YYYY-MM-DD' */
export function dateInTimezone(iso: string, timeZone: string = TENANT_TIMEZONE): string {
  const t = new Date(iso).getTime();
  const y = part(timeZone, t, 'year');
  const m = part(timeZone, t, 'month');
  const d = part(timeZone, t, 'day');
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 某时区的“今天” */
export function todayInTimezone(timeZone: string = TENANT_TIMEZONE, now: Date = new Date()): string {
  return dateInTimezone(now.toISOString(), timeZone);
}

/** 某时区某自然日 00:00 对应的 UTC 毫秒时间戳 */
export function dayStartMsInTimezone(date: string, timeZone: string = TENANT_TIMEZONE): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  // 取当天 UTC 中午的偏移：午夜前后的夏令时切换不会影响到中午的偏移
  const offset = tzOffsetMs(timeZone, Date.UTC(y, m - 1, d, 12, 0, 0));
  return Date.UTC(y, m - 1, d) - offset;
}

/** 'YYYY-MM-DD' 加减天数（纯日历运算，与时区无关） */
export function addDays(date: string, days: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
}
