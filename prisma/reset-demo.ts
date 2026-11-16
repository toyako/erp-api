/**
 * 演示数据重建（reset-demo）：先清库、再跑种子，把线上演示库恢复成干净的种子数据。
 *
 * 用途：演示数据被实测污染后一键重建（2026-11-16 用户定）。
 * 种子本身只 upsert 不清表，直接重跑种子清不掉测试痕迹（TEST-001、testuser、
 * PO-MWIOEAI1、RMA-MWJ14CGK、TRF-*、TEST-SKU-001、早期测试单据等），
 * 所以先按外键安全顺序 deleteMany 全表，再调 `prisma db seed`。
 *
 * 安全阀：必须显式设置 DEMO_RESET_CONFIRMED=1 才会执行，否则直接退出；
 * CI 不跑它，Render 部署不跑它，只能由人在 Render Shell 里手动跑：
 *   DEMO_RESET_CONFIRMED=1 npx tsx prisma/reset-demo.ts
 *
 * 注意：种子会把 SKU-001 价格重建成 ¥199（2026-01-01 生效）；用户 2026-11-16
 * 17:24 已定 SKU-001 留 ¥209，重建后需再建一条 ¥209 价格记录（定价取生效
 * 最晚一条），本脚本不管价格——重建完用接口另行改回。
 */
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** 子表在前、父表在后，违反外键会直接报错停住（不做 truncate 级联） */
const TABLES = [
  'auditEvent',
  'stockMovement',
  'paymentRecord',
  'orderLine',
  'rma',
  'stocktake',
  'transfer',
  'purchaseOrderLine',
  'purchaseOrder',
  'salesOrder',
  'priceList',
  'inventoryLot',
  'customer',
  'supplier',
  'sku',
  'spu',
  'principal',
  'tenant',
] as const;

async function main() {
  if (process.env.DEMO_RESET_CONFIRMED !== '1') {
    console.error('拒绝执行：请显式设置 DEMO_RESET_CONFIRMED=1（防误删）');
    process.exitCode = 1;
    return;
  }

  console.log('reset-demo：开始清库（18 张表，deleteMany）…');
  for (const table of TABLES) {
    const { count } = await (prisma[table] as { deleteMany: () => Promise<{ count: number }> }).deleteMany();
    console.log(`  ${table}: 删除 ${count} 行`);
  }

  console.log('reset-demo：清库完成，开始跑种子（prisma db seed）…');
  execSync('npx prisma db seed', { stdio: 'inherit' });
  console.log('reset-demo：重建完成（种子数据已恢复；SKU-001 价格为种子价 ¥199，记得另行改回 ¥209）');
}

main()
  .catch((error) => {
    console.error('reset-demo 失败：', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
