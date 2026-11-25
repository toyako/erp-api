import type { PageQueryParams } from '@erp/contracts';
import type { Page } from './ports';
import { todayInTimezone } from './timezone';

/**
 * 单号生成：`前缀-日期(租户时区 YYYYMMDD)-当日 4 位序号`，如 SO-20261123-0001。
 *
 * 序号是“当日第几单”：进程内按 (前缀, 日期) 记已发序号，同一进程内连建多单
 * 严格递增；首用时先从库里取当日已有的最大序号做种子（分页拉全量），
 * 这样进程重启（Render 睡眠唤醒、重新部署）后也不会从 0001 重发——
 * 各单号列都是 @unique，撞号会直接插库失败。
 * 并发：播种只跑一次（同一进程内并发首调用共用一个播种 promise），
 * 播种完成后取号是同步计算（算序号、记已发、拼串之间无 await），
 * 同一进程内不可能分到同一号；跨进程仍可能撞号（多实例部署），
 * 演示规模下可接受；真生产应改用数据库序列/雪花 id。
 * 一日超过 9999 单时序号继续涨成 5 位（如 10000），仍唯一。
 */
const PAGE_SIZE = 200;
const SEQ_LEN = 4;

type Entry = {
  seeded: boolean;
  seeding: Promise<void> | null;
  next: number;
};

const state = new Map<string, Entry>();

/** 仅测试用：清空进程内序号缓存，模拟进程重启后再次取号。 */
export function resetDocNoState(): void {
  state.clear();
}

export async function nextDocNo<T>(
  prefix: string,
  listPage: (params: PageQueryParams) => Promise<Page<T>>,
  pickNo: (item: T) => string,
): Promise<string> {
  const date = todayInTimezone().replaceAll('-', '');
  const key = `${prefix}-${date}`;
  let entry = state.get(key);
  if (!entry) {
    entry = { seeded: false, seeding: null, next: 1 };
    state.set(key, entry);
  }
  const current = entry;
  if (!current.seeded) {
    if (!current.seeding) {
      current.seeding = (async () => {
        const re = new RegExp(`^${prefix}-${date}-(\\d+)$`);
        let max = 0;
        let page = 1;
        for (;;) {
          const result = await listPage({ page, pageSize: PAGE_SIZE });
          for (const item of result.items) {
            const m = re.exec(pickNo(item));
            if (m) {
              const n = Number(m[1]);
              if (Number.isSafeInteger(n) && n > max) max = n;
            }
          }
          if (result.items.length === 0 || page * PAGE_SIZE >= result.total) break;
          page += 1;
        }
        current.next = max + 1;
      })();
    }
    try {
      await current.seeding;
    } catch (error) {
      // 播种失败：清掉播种态，下次调用重试；本次直接抛错（建单本就会失败）
      current.seeding = null;
      throw error;
    }
    current.seeded = true;
    current.seeding = null;
  }
  const seq = current.next;
  current.next += 1;
  return `${prefix}-${date}-${String(seq).padStart(SEQ_LEN, '0')}`;
}
