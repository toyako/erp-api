/**
 * 演示数据初始化（ADR-0007）：全部为虚构数据，禁止导入真实业务数据（ADR-0008）。
 * 执行：pnpm exec prisma db seed
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const TENANT = '00000000-0000-4000-8000-000000000001';
const SPU = '00000000-0000-4000-8000-000000000100';
const DEMO_PASSWORD = 'demo1234';

const CATALOG = [
  {
    skuId: '00000000-0000-4000-8000-000000000101',
    lotId: '00000000-0000-4000-8000-000000000201',
    code: 'SKU-001',
    spec: '标准版',
    unit: '套',
    amount: 19900,
    batchCode: 'BATCH-001',
    location: '主仓',
    quantity: 100,
  },
  {
    skuId: '00000000-0000-4000-8000-000000000102',
    lotId: '00000000-0000-4000-8000-000000000202',
    code: 'SKU-002',
    spec: '专业版',
    unit: '套',
    amount: 29900,
    batchCode: 'BATCH-002',
    location: '华东仓',
    quantity: 50,
  },
];

async function main() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  await prisma.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: '演示租户' },
  });

  for (const [username, displayName, roles] of [
    ['admin', '管理员', ['admin']],
    ['sales', '销售', ['sales']],
    ['viewer', '只读', ['readonly']],
  ] as const) {
    await prisma.principal.upsert({
      where: { username },
      update: { passwordHash },
      create: {
        tenantId: TENANT,
        username,
        displayName,
        roles: [...roles],
        passwordHash,
      },
    });
  }

  await prisma.spu.upsert({
    where: { id: SPU },
    update: {},
    create: {
      id: SPU,
      tenantId: TENANT,
      name: '云智物标准套件',
      categoryCode: 'SOFTWARE',
      description: '演示商品，数据全部虚构',
      enabled: true,
    },
  });

  for (const item of CATALOG) {
    await prisma.sku.upsert({
      where: { id: item.skuId },
      update: {},
      create: {
        id: item.skuId,
        spuId: SPU,
        code: item.code,
        spec: item.spec,
        unit: item.unit,
        enabled: true,
      },
    });

    // PriceList 无唯一键，按 SKU 重建保证幂等
    await prisma.priceList.deleteMany({ where: { skuId: item.skuId } });
    await prisma.priceList.create({
      data: {
        skuId: item.skuId,
        channelCode: 'DIRECT',
        amount: item.amount,
        currency: 'CNY',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });

    await prisma.inventoryLot.upsert({
      where: { id: item.lotId },
      update: {
        availableQty: item.quantity,
        reservedQty: 0,
        totalQty: item.quantity,
      },
      create: {
        id: item.lotId,
        tenantId: TENANT,
        skuId: item.skuId,
        batchCode: item.batchCode,
        location: item.location,
        availableQty: item.quantity,
        reservedQty: 0,
        totalQty: item.quantity,
      },
    });
  }

  for (const supplier of [
    { code: 'SUP-001', name: '杭州云启科技', contact: '王工', phone: '0571-88886666', rating: 5 },
    { code: 'SUP-002', name: '深圳智联电子', contact: '李经理', phone: '0755-88887777', rating: 4 },
  ]) {
    await prisma.supplier.upsert({
      where: { code: supplier.code },
      update: {},
      create: { tenantId: TENANT, ...supplier },
    });
  }

  // 客户档案：只加这 3 个，其余种子逻辑不动（尤其 lots 的 upsert 别碰）
  const customers = [
    { id: '00000000-0000-4000-8000-000000000401', code: 'CUST-001', name: '华东贸易有限公司', phone: '0571-88889999', level: 'vip' },
    { id: '00000000-0000-4000-8000-000000000402', code: 'CUST-002', name: '李明', phone: '13800001111', level: 'regular' },
    { id: '00000000-0000-4000-8000-000000000403', code: 'CUST-003', name: '门店散客', phone: null, level: 'regular' },
  ] as const;
  for (const customer of customers) {
    await prisma.customer.upsert({
      where: { code: customer.code },
      update: {},
      create: { id: customer.id, tenantId: TENANT, ...customer },
    });
  }

  // 两单关联客户：订单是运行期经接口建的（seed 从不建单），库里有才挂上去，没有就是 no-op
  await prisma.salesOrder.updateMany({
    where: { orderNo: 'ERP-MWHLQJA6' },
    data: { customerId: '00000000-0000-4000-8000-000000000401' },
  });
  await prisma.salesOrder.updateMany({
    where: { orderNo: 'ERP-MWHNJYPX' },
    data: { customerId: '00000000-0000-4000-8000-000000000402' },
  });

  // 演示退货单：只针对已履约订单 ERP-MWI063YR 的 SKU-001 ×1，¥199，待审核。
  // 订单是运行期建的，库里没有就是 no-op（硬写 FK 会断 seed）；与 InMemory / admin 兜底同口径。
  const demoOrder = await prisma.salesOrder.findUnique({ where: { orderNo: 'ERP-MWI063YR' } });
  if (demoOrder) {
    const demoLine = await prisma.orderLine.findFirst({
      where: { orderId: demoOrder.id, skuId: '00000000-0000-4000-8000-000000000101' },
    });
    if (demoLine) {
      await prisma.rma.upsert({
        where: { rmaNo: 'RMA-DEMO-001' },
        update: {},
        create: {
          id: '00000000-0000-4000-8000-000000000902',
          tenantId: TENANT,
          rmaNo: 'RMA-DEMO-001',
          orderId: demoOrder.id,
          skuId: demoLine.skuId,
          quantity: 1,
          reason: '质量问题',
          status: 'requested',
          refundAmount: demoLine.unitAmount,
          currency: demoLine.currency,
        },
      });
    }
  }

  // 演示调拨单：SKU-001 主仓→华东仓 ×5，待完成。调拨不挂外键，库里没有就建，与 InMemory / admin 兜底同口径。
  await prisma.transfer.upsert({
    where: { transferNo: 'TRF-DEMO-001' },
    update: {},
    create: {
      id: '00000000-0000-4000-8000-000000000903',
      tenantId: TENANT,
      transferNo: 'TRF-DEMO-001',
      skuId: '00000000-0000-4000-8000-000000000101',
      fromLocation: '主仓',
      toLocation: '华东仓',
      quantity: 5,
      status: 'draft',
    },
  });

  // 演示盘点单：针对 BATCH-001，实盘 100，系统数取当时总量，差异据实算；库里没该批次就是 no-op。
  const demoLot = await prisma.inventoryLot.findFirst({ where: { batchCode: 'BATCH-001' } });
  if (demoLot) {
    await prisma.stocktake.upsert({
      where: { stocktakeNo: 'STK-DEMO-001' },
      update: {},
      create: {
        id: '00000000-0000-4000-8000-000000000904',
        tenantId: TENANT,
        stocktakeNo: 'STK-DEMO-001',
        lotId: demoLot.id,
        skuId: demoLot.skuId,
        countedQty: 100,
        systemQty: demoLot.totalQty,
        difference: 100 - demoLot.totalQty,
        status: 'draft',
      },
    });
  }

  console.log('seed done: 1 tenant / 3 principals / 1 SPU / 2 SKU / 2 lots / 2 suppliers / 3 customers');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
