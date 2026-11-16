import { randomInt } from 'node:crypto';

/**
 * 单号生成：`前缀-时间戳(base36 大写)+2 位随机 base36 后缀`，如 ERP-MWJ14OXF7K。
 *
 * 只加随机后缀仍不够：同一毫秒内建多单时，20 单同毫秒纯随机的碰撞概率约 14%
 *（20 选 2 对 / 36²），而建单实测可快于 1ms（FIX 批 dashboard 测试三单同毫秒撞号）。
 * 故进程内对同毫秒已发后缀去重：同一毫秒内随机后缀已用过则重抽（最多 10 次），
 * 保证同一进程内同一毫秒生成的单号不重。跨进程仍可能撞号（多实例部署），
 * 演示规模下可接受；真生产应改用数据库序列/雪花 id。
 */
const SUFFIX_RADIX = 36;
const SUFFIX_LEN = 2;
const MAX_SUFFIX = SUFFIX_RADIX ** SUFFIX_LEN; // 1296
const MAX_REROLLS = 10;

let lastMs = 0;
const usedThisMs = new Set<string>();

function randomSuffix(): string {
  return randomInt(MAX_SUFFIX).toString(SUFFIX_RADIX).padStart(SUFFIX_LEN, '0');
}

export function nextDocNo(prefix: string): string {
  const ms = Date.now();
  if (ms !== lastMs) {
    lastMs = ms;
    usedThisMs.clear();
  }
  let suffix = randomSuffix();
  let tries = 0;
  while (usedThisMs.has(suffix) && tries < MAX_REROLLS) {
    suffix = randomSuffix();
    tries += 1;
  }
  usedThisMs.add(suffix);
  return `${prefix}-${ms.toString(SUFFIX_RADIX).toUpperCase()}${suffix.toUpperCase()}`;
}
