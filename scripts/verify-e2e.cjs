/**
 * 真实链路验证：Prisma 直连 Supabase
 * 1) 直接查库确认 seed 已落库
 * 2) 起服务 → 登录拿 JWT → /users/me → 查 SKU → 下单 → 库存扣减
 * 3) 杀进程重启 → 订单仍在（证明持久化，不是内存）
 *
 * 运行：node scripts/verify-e2e.cjs
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = '3100';
const BASE = `http://127.0.0.1:${PORT}/api`;

// 加载 .env
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}
process.env.ERP_DB_ADAPTER = 'prisma';
process.env.PORT = PORT;
delete process.env.API_PORT;

const lines = [];
const ok = (name, detail) => lines.push(`PASS ${name}${detail ? ` :: ${detail}` : ''}`);
const bad = (name, detail) => lines.push(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`);

let serverLog = '';

function startServer() {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });
  return child;
}

async function waitReady(tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      // 未就绪
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  // --- 1. 直接查库 ---
  const counts = {
    tenants: await prisma.tenant.count(),
    principals: await prisma.principal.count(),
    spus: await prisma.spu.count(),
    skus: await prisma.sku.count(),
    prices: await prisma.priceList.count(),
    lots: await prisma.inventoryLot.count(),
  };
  lines.push(`DB ${JSON.stringify(counts)}`);
  if (counts.skus === 2 && counts.lots === 2 && counts.principals === 3) ok('seed 数据已落库');
  else bad('seed 数据异常', JSON.stringify(counts));

  const before = await prisma.inventoryLot.findFirst({ where: { skuId: '00000000-0000-4000-8000-000000000101' } });
  lines.push(`DB lot_before available=${before.availableQty} reserved=${before.reservedQty}`);

  // --- 2. 起服务走 HTTP ---
  let child = startServer();
  if (!(await waitReady())) {
    bad('服务启动', 'health 未就绪');
    child.kill();
    await prisma.$disconnect();
    return;
  }
  ok('服务启动 (ERP_DB_ADAPTER=prisma)');

  const loginRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'demo1234' }),
  });
  const login = await loginRes.json();
  if (loginRes.ok && login.accessToken && login.accessToken.split('.').length === 3) {
    ok('真实登录签发 JWT', `expiresIn=${login.expiresIn}`);
  } else {
    bad('登录失败', JSON.stringify(login).slice(0, 160));
  }

  const meRes = await fetch(`${BASE}/users/me`, {
    headers: { authorization: `Bearer ${login.accessToken}` },
  });
  const me = await meRes.json();
  if (meRes.ok && me.username === 'admin') ok('GET /users/me 校验令牌', `roles=${JSON.stringify(me.roles)}`);
  else bad('/users/me 失败', JSON.stringify(me).slice(0, 160));

  const unauth = await fetch(`${BASE}/users/me`);
  if (unauth.status === 401) ok('无令牌访问 /users/me 返回 401');
  else bad('鉴权未生效', `status=${unauth.status}`);

  const skuRes = await fetch(`${BASE}/products/skus`);
  const skuPage = await skuRes.json();
  const skuId = skuPage.items && skuPage.items[0] && skuPage.items[0].id;
  if (skuId) ok('查商品', `total=${skuPage.total}`);
  else bad('查商品为空');

  const orderRes = await fetch(`${BASE}/sales/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${login.accessToken}` },
    body: JSON.stringify({ lines: [{ skuId, quantity: 3 }] }),
  });
  const order = await orderRes.json();
  if (orderRes.ok && order.orderNo) ok('下单成功', `orderNo=${order.orderNo} total=${order.total && order.total.amount}`);
  else bad('下单失败', JSON.stringify(order).slice(0, 200));

  if (orderRes.ok && order.total && order.total.amount !== 59700) {
    bad('服务端定价异常', `expected 59700 got ${order.total.amount}`);
  } else if (orderRes.ok) {
    ok('服务端按价格表计价', '3 × 19900 = 59700');
  }

  const after = await prisma.inventoryLot.findFirst({ where: { skuId: '00000000-0000-4000-8000-000000000101' } });
  lines.push(`DB lot_after available=${after.availableQty} reserved=${after.reservedQty}`);
  if (after.availableQty === before.availableQty - 3 && after.reservedQty === before.reservedQty + 3) {
    ok('库存真实扣减并落库');
  } else {
    bad('库存扣减异常');
  }

  child.kill();
  await new Promise((r) => setTimeout(r, 1500));

  // --- 3. 重启再查（证明持久化） ---
  child = startServer();
  if (!(await waitReady())) {
    bad('重启服务');
    child.kill();
    await prisma.$disconnect();
    return;
  }
  const ordersAfterRestart = await fetch(`${BASE}/sales/orders`).then((r) => r.json());
  const found = (ordersAfterRestart.items || []).some((o) => o.orderNo === order.orderNo);
  if (found) ok('重启后订单仍在（数据不在内存）', `orders=${ordersAfterRestart.total}`);
  else bad('重启后订单丢失');

  child.kill();
  await prisma.$disconnect();
}

main()
  .catch((error) => lines.push(`ERROR ${String(error && error.message).slice(0, 300)}`))
  .finally(() => {
    const failed = lines.filter((l) => l.startsWith('FAIL') || l.startsWith('ERROR'));
    lines.push(`---`);
    lines.push(failed.length === 0 ? 'E2E OK' : `E2E FAILED (${failed.length})`);
    fs.writeFileSync(path.join(ROOT, '..', '.e2e-report.txt'), `${lines.join('\n')}\n`, 'ascii');
    fs.writeFileSync(path.join(ROOT, '..', '.server-log.txt'), `${serverLog.slice(-6000)}\n`, 'utf8');
    process.exitCode = failed.length === 0 ? 0 : 1;
  });
