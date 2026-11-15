const port = Number(process.env.SMOKE_PORT || 3311);
process.env.API_PORT = String(port);
require('../dist/main.js');

const base = `http://127.0.0.1:${port}/api`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {
      // server not up yet
    }
    await sleep(200);
  }
  throw new Error('erp-api did not become ready');
}

async function call(path, options) {
  const r = await fetch(base + path, options);
  let body = {};
  try { body = await r.json(); } catch { /* empty body */ }
  return { status: r.status, body };
}

const jsonPost = (value) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

async function main() {
  await waitReady();

  const health = await call('/health');
  const login = await call('/auth/login', jsonPost({ username: 'admin', password: 'demo1234' }));
  const skus = await call('/products/skus');
  const sku = skus.body.items && skus.body.items[0];
  if (!sku) throw new Error('no seed SKU');

  const before = await call('/inventory/lots');
  const created = await call('/sales/orders', jsonPost({ lines: [{ skuId: sku.id, quantity: 2 }] }));
  const after = await call('/inventory/lots');
  const id = created.body.id;

  const paid = id ? await call(`/sales/orders/${id}/pay`, { method: 'POST' }) : { status: 0, body: {} };
  const fulfilled = id ? await call(`/sales/orders/${id}/fulfill`, { method: 'POST' }) : { status: 0, body: {} };
  const badState = id ? await call(`/sales/orders/${id}/pay`, { method: 'POST' }) : { status: 0, body: {} };
  const oversell = await call('/sales/orders', jsonPost({ lines: [{ skuId: sku.id, quantity: 99999 }] }));
  const afterRollback = await call('/inventory/lots');

  const lotBefore = (before.body.items || [])[0] || {};
  const lotAfter = (after.body.items || [])[0] || {};
  const lotRolled = (afterRollback.body.items || [])[0] || {};

  const checks = {
    health: health.status === 200 && health.body.status === 'ok',
    login: login.status === 201 && Boolean(login.body.accessToken),
    seedSkus: (skus.body.items || []).length >= 2,
    orderCreated: created.status === 201 && created.body.status === 'confirmed',
    serverSidePricing: created.body.total && created.body.total.amount === 39800,
    stockReserved: lotAfter.reservedQty === (lotBefore.reservedQty || 0) + 2,
    totalUnchanged: lotAfter.totalQty === lotBefore.totalQty,
    paid: paid.body.status === 'paid',
    fulfilled: fulfilled.body.status === 'fulfilled',
    terminalStateRejected: badState.status === 409 && badState.body.code === 'INVALID_STATE',
    oversellRejected: oversell.status === 409 && oversell.body.code === 'INSUFFICIENT_STOCK',
    transactionRollback: lotRolled.reservedQty === lotAfter.reservedQty,
  };

  console.log(JSON.stringify({ checks, sample: { orderTotal: created.body.total, reservedQty: lotAfter.reservedQty } }, null, 2));
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  if (failed.length) {
    console.error('FAILED: ' + failed.join(', '));
    process.exit(1);
  }
  console.log('SMOKE OK: all ' + Object.keys(checks).length + ' checks passed');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
