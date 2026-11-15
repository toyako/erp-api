/**
 * 公网链路验证：Render API → Supabase
 * 用法：node scripts/verify-public.cjs [baseUrl]
 * 默认 https://erp-api-0fnu.onrender.com/api（免费层冷启动可能 50s+）
 */
const fs = require('node:fs');

const BASE = (process.argv[2] || 'https://erp-api-0fnu.onrender.com/api').replace(/\/$/, '');
const SKU = '00000000-0000-4000-8000-000000000101';
const ORIGIN = 'https://erp-admin-eosin.vercel.app';

const lines = [];
const ok = (n, d) => lines.push(`PASS ${n}${d ? ` :: ${d}` : ''}`);
const bad = (n, d) => lines.push(`FAIL ${n}${d ? ` :: ${d}` : ''}`);

async function req(path, init = {}, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  lines.push(`base=${BASE}`);

  const t0 = Date.now();
  let health = null;
  for (let i = 0; i < 3; i += 1) {
    try {
      health = await req('/health');
      if (health.status === 200) break;
    } catch (error) {
      lines.push(`RETRY ${String(error.message).slice(0, 80)}`);
    }
  }
  lines.push(`wake_ms=${Date.now() - t0}`);
  if (health && health.status === 200) ok('GET /health', JSON.stringify(health.body));
  else bad('GET /health', health ? `status=${health.status}` : 'unreachable');

  const login = await req('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'demo1234' }),
  });
  const token = login.body && login.body.accessToken;
  if (login.status < 300 && token) ok('POST /auth/login', `jwt_segments=${token.split('.').length}`);
  else bad('POST /auth/login', JSON.stringify(login.body).slice(0, 160));

  const me = await req('/users/me', { headers: { authorization: `Bearer ${token}` } });
  if (me.status === 200 && me.body.username === 'admin') ok('GET /users/me', `roles=${JSON.stringify(me.body.roles)}`);
  else bad('GET /users/me', JSON.stringify(me.body).slice(0, 160));

  const noAuth = await req('/users/me');
  if (noAuth.status === 401) ok('无令牌访问返回 401');
  else bad('鉴权未生效', `status=${noAuth.status}`);

  const before = await req('/inventory/lots');
  const lotBefore = (before.body.items || []).find((l) => l.skuId === SKU);
  lines.push(`lot_before available=${lotBefore && lotBefore.availableQty}`);

  const order = await req('/sales/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ lines: [{ skuId: SKU, quantity: 2 }] }),
  });
  if (order.status < 300 && order.body.orderNo) {
    ok('POST /sales/orders', `orderNo=${order.body.orderNo} total=${order.body.total && order.body.total.amount}`);
  } else {
    bad('POST /sales/orders', JSON.stringify(order.body).slice(0, 200));
  }

  const after = await req('/inventory/lots');
  const lotAfter = (after.body.items || []).find((l) => l.skuId === SKU);
  lines.push(`lot_after available=${lotAfter && lotAfter.availableQty} reserved=${lotAfter && lotAfter.reservedQty}`);
  if (lotBefore && lotAfter && lotAfter.availableQty === lotBefore.availableQty - 2) {
    ok('公网下单已扣减库存');
  } else {
    bad('库存未按预期扣减');
  }

  const orders = await req('/sales/orders');
  const found = ((orders.body && orders.body.items) || []).some((o) => o.orderNo === order.body.orderNo);
  if (found) ok('订单查询可见', `orders=${orders.body.total}`);
  else bad('订单未查到');

  const cors = await req('/health', { headers: { origin: ORIGIN } });
  const allowOrigin = cors.headers.get('access-control-allow-origin');
  lines.push(`cors_allow_origin=${allowOrigin || 'none'}`);

  const failed = lines.filter((l) => l.startsWith('FAIL'));
  lines.push('---');
  lines.push(failed.length === 0 ? 'PUBLIC E2E OK' : `PUBLIC E2E FAILED (${failed.length})`);
  fs.writeFileSync('D:/Project/erp-platform/.public-e2e.txt', `${lines.join('\n')}\n`, 'ascii');
  process.exitCode = failed.length === 0 ? 0 : 1;
})();
