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
 *
 * 清空模式：DEMO_RESET_MODE=empty 时只清库、不跑种子，得到真正空库；
 * 此时保留租户行（tenant）与登录账号（principal），其余 29 张业务表全部删空。
 * 租户 id 是代码里写死的默认租户（src/application/sales.service.ts 的 TENANT_ID），
 * 账号是 admin/sales/viewer——删了这两张表，演示站就登不进去、建单也会断外键。
 * 默认不设 DEMO_RESET_MODE 时保持老行为：清库 + 跑种子。
 */
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** 子表在前、父表在后，违反外键会直接报错停住（不做 truncate 级联） */
const TABLES = [
  'auditEvent',
  'exchange',
  'approvalRule',
  'stockMovement',
  'paymentRecord',
  'orderLine',
  'rma',
  'stocktake',
  'transfer',
  'shipmentLine',
  'shipment',
  'invoice',
  'goodsReceiptLine',
  'goodsReceipt',
  'purchaseOrderLine',
  'purchaseOrder',
  'salesOrder',
  'priceList',
  'priceTier',
  'inventoryLot',
  'customer',
  'levelRule',
  'customerFollowup',
  'customerBalanceTx',
  'supplier',
  'sku',
  'spu',
  'category',
  'warehouse',
  'principal',
  'tenant',
] as const;

async function main() {
  if (process.env.DEMO_RESET_CONFIRMED !== '1') {
    console.error('拒绝执行：请显式设置 DEMO_RESET_CONFIRMED=1（防误删）');
    process.exitCode = 1;
    return;
  }

  const emptyMode = process.env.DEMO_RESET_MODE === 'empty';
  // 清空模式保留租户与登录账号，其余表全删；默认模式全删后跑种子
  const tables = emptyMode ? TABLES.filter((t) => t !== 'tenant' && t !== 'principal') : TABLES;

  console.log(`reset-demo：开始清库（${tables.length} 张表，deleteMany）…`);
  for (const table of tables) {
    const { count } = await (prisma[table] as { deleteMany: () => Promise<{ count: number }> }).deleteMany();
    console.log(`  ${table}: 删除 ${count} 行`);
  }

  if (emptyMode) {
    console.log('reset-demo：已清空（empty 模式，不跑种子；租户与登录账号已保留）');
    return;
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
