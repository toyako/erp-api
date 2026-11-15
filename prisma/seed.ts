/**
 * 演示数据初始化（ADR-0007）。
 * P2 接入 Prisma 后执行：pnpm exec prisma db seed
 * 全部为虚构数据，禁止导入任何真实业务数据（ADR-0008）。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TENANT = '00000000-0000-4000-8000-000000000001';

async function main() {
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
      update: {},
      create: {
        tenantId: TENANT,
        username,
        displayName,
        roles: [...roles],
        passwordHash: 'demo-only-not-a-real-hash',
      },
    });
  }

  console.log('seed done: 1 tenant, 3 principals');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
