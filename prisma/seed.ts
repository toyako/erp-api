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
        availableQty: item.quantity,
        reservedQty: 0,
        totalQty: item.quantity,
      },
    });
  }

  console.log('seed done: 1 tenant / 3 principals / 1 SPU / 2 SKU / 2 lots');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
