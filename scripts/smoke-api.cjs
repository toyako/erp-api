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

  const draftPay = id ? await call(`/sales/orders/${id}/pay`, { method: 'POST' }) : { status: 0, body: {} };
  const confirmed = id ? await call(`/sales/orders/${id}/confirm`, { method: 'POST' }) : { status: 0, body: {} };
  const paid = id ? await call(`/sales/orders/${id}/pay`, { method: 'POST' }) : { status: 0, body: {} };
  const fulfilled = id ? await call(`/sales/orders/${id}/fulfill`, { method: 'POST' }) : { status: 0, body: {} };
  const badState = id ? await call(`/sales/orders/${id}/pay`, { method: 'POST' }) : { status: 0, body: {} };
  const oversell = await call('/sales/orders', jsonPost({ lines: [{ skuId: sku.id, quantity: 99999 }] }));
  const afterRollback = await call('/inventory/lots');
  const afterFulfill = await call('/inventory/lots');
  const created2 = await call('/sales/orders', jsonPost({ lines: [{ skuId: sku.id, quantity: 1 }] }));
  const id2 = created2.body.id;
  const cancelled = id2 ? await call(`/sales/orders/${id2}/cancel`, { method: 'POST' }) : { status: 0, body: {} };
  const afterCancel = await call('/inventory/lots');

  // 仪表盘汇总：只断言形状与下限——冒烟自身建了 2 单（1 已完成、1 已取消），
  // 其余绝对值会随种子变化，不写死
  const overview = await call('/dashboard/overview');
  const report = await call('/dashboard/report?range=7d');
  const financeSummary = await call('/dashboard/finance-summary');
  const todos = await call('/dashboard/todos?page=1&pageSize=2');
  const receivables = await call('/dashboard/receivables?page=1&pageSize=2');
  const activity = await call('/dashboard/recent-activity');
  const movements = await call('/dashboard/movements?page=1&pageSize=2');

  const lotBefore = (before.body.items || [])[0] || {};
  const lotAfter = (after.body.items || [])[0] || {};
  const lotRolled = (afterRollback.body.items || [])[0] || {};
  const lotFulfilled = (afterFulfill.body.items || [])[0] || {};
  const lotCancelled = (afterCancel.body.items || [])[0] || {};

  const checks = {
    health: health.status === 200 && health.body.status === 'ok',
    login: login.status === 201 && Boolean(login.body.accessToken),
    seedSkus: (skus.body.items || []).length >= 2,
    orderCreated: created.status === 201 && created.body.status === 'draft',
    serverSidePricing: created.body.total && created.body.total.amount === 39800,
    stockReserved: lotAfter.reservedQty === (lotBefore.reservedQty || 0) + 2,
    totalUnchanged: lotAfter.totalQty === lotBefore.totalQty,
    draftPayRejected: draftPay.status === 409 && draftPay.body.code === 'INVALID_STATE',
    orderConfirmed: confirmed.body.status === 'confirmed',
    paid: paid.body.status === 'paid',
    fulfilled: fulfilled.body.status === 'fulfilled',
    terminalStateRejected: badState.status === 409 && badState.body.code === 'INVALID_STATE',
    oversellRejected: oversell.status === 409 && oversell.body.code === 'INSUFFICIENT_STOCK',
    transactionRollback: lotRolled.reservedQty === lotFulfilled.reservedQty && lotRolled.totalQty === lotFulfilled.totalQty,
    fulfillConsumed: lotFulfilled.totalQty === lotBefore.totalQty - 2 && lotFulfilled.reservedQty === (lotBefore.reservedQty || 0),
    orderCancelled: cancelled.body.status === 'cancelled',
    cancelReleased: lotCancelled.reservedQty === lotFulfilled.reservedQty && lotCancelled.availableQty === lotFulfilled.availableQty && lotCancelled.totalQty === lotFulfilled.totalQty,
    dashboardOverview: overview.status === 200 && overview.body.orderCount >= 2 && typeof overview.body.salesAmount === 'number' && (overview.body.trend7 || []).length === 7 && Array.isArray(overview.body.ranking) && Boolean(overview.body.firstSku && overview.body.firstSku.code),
    dashboardReport: report.status === 200 && report.body.range === '7d' && (report.body.buckets || []).length === 6 && (report.body.buckets || []).reduce((n, b) => n + b.amount, 0) > 0,
    dashboardFinance: financeSummary.status === 200 && ['receivable', 'payable', 'receivedThisMonth', 'paidThisMonth'].every((k) => typeof financeSummary.body[k] === 'number') && financeSummary.body.receivedThisMonth >= 39800,
    dashboardTodosPaged: todos.status === 200 && todos.body.total >= 2 && (todos.body.items || []).length <= 2,
    dashboardReceivablesPaged: receivables.status === 200 && receivables.body.total >= 1 && (receivables.body.items || []).length >= 1,
    dashboardActivity: activity.status === 200 && Array.isArray(activity.body) && activity.body.length >= 2,
    dashboardMovementsPaged: movements.status === 200 && movements.body.total >= 1 && (movements.body.items || []).length <= 2,
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
