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
  const skuB = skus.body.items && skus.body.items[1];
  if (!skuB) throw new Error('no second seed SKU');
  const spus = await call('/products/spus');
  const spu = spus.body.items && spus.body.items[0];
  if (!spu) throw new Error('no seed SPU');

  // 新建 SKU：成功 + 编码重复 409；价格档案：列表 + 新建（用 SKU-002，避免改 SKU-001 的定价影响后续订单金额断言）
  const skuCreated = await call('/products/skus', jsonPost({ spuId: spu.id, code: 'SKU-SMOKE', spec: '冒烟版', unit: '件' }));
  const skuDuplicate = await call('/products/skus', jsonPost({ spuId: spu.id, code: 'SKU-SMOKE', spec: '重复', unit: '件' }));
  const prices = await call('/products/prices');
  const priceCreated = await call('/products/prices', jsonPost({ skuId: skuB.id, price: { amount: 31900, currency: 'CNY' } }));

  // 用户管理：新建用户 + 新用户能登录
  const principalCreated = await call('/iam/principals', jsonPost({ username: 'smoke', password: 'smoke123', displayName: '冒烟用户', roles: ['sales'] }));
  const smokeLogin = principalCreated.body.id ? await call('/auth/login', jsonPost({ username: 'smoke', password: 'smoke123' })) : { status: 0, body: {} };
  const principals = await call('/iam/principals');

  const customers = await call('/customers');
  const newCustomer = await call('/customers', jsonPost({ code: 'CUST-SMOKE', name: '冒烟客户', level: 'vip' }));
  const gotCustomer = newCustomer.body.id ? await call(`/customers/${newCustomer.body.id}`) : { status: 0, body: {} };

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

  // 退货闭环：对已履约订单建 RMA（qty 1）→审核→收货回补库存→退款
  const rmaList = await call('/rmas');
  const rmaCreated = await call('/rmas', jsonPost({ orderId: id, skuId: sku.id, quantity: 1, reason: '冒烟退货' }));
  const rmaId = rmaCreated.body.id;
  const rmaApproved = rmaId ? await call(`/rmas/${rmaId}/approve`, { method: 'POST' }) : { status: 0, body: {} };
  const rmaReceived = rmaId ? await call(`/rmas/${rmaId}/receive`, { method: 'POST' }) : { status: 0, body: {} };
  const lotAfterRma = (await call('/inventory/lots')).body.items?.[0] || {};
  const rmaRefunded = rmaId ? await call(`/rmas/${rmaId}/refund`, { method: 'POST' }) : { status: 0, body: {} };
  const rmaOver = await call('/rmas', jsonPost({ orderId: id, skuId: sku.id, quantity: 2, reason: '超余量' }));

  // 调拨与盘点闭环：建调拨→完成（源批次扣数、目标新建同批次）→建盘点→确认（总量按实盘改）
  const transfersList = await call('/transfers');
  const stocktakesList = await call('/stocktakes');
  const transferCreated = await call('/transfers', jsonPost({ skuId: sku.id, fromLocation: '主仓', toLocation: '华东仓', quantity: 2 }));
  const transferId = transferCreated.body.id;
  const transferCompleted = transferId ? await call(`/transfers/${transferId}/complete`, { method: 'POST' }) : { status: 0, body: {} };
  const lotsAfterTransfer = (await call('/inventory/lots')).body.items || [];
  const sourceAfterTransfer = lotsAfterTransfer.find((l) => l.batchCode === 'BATCH-001' && l.location === '主仓') || {};
  const destAfterTransfer = lotsAfterTransfer.find((l) => l.batchCode === 'BATCH-001' && l.location === '华东仓') || {};
  const stocktakeCreated = await call('/stocktakes', jsonPost({ lotId: sourceAfterTransfer.id, countedQty: sourceAfterTransfer.totalQty - 1 }));
  const stocktakeId = stocktakeCreated.body.id;
  const stocktakeConfirmed = stocktakeId ? await call(`/stocktakes/${stocktakeId}/confirm`, { method: 'POST' }) : { status: 0, body: {} };
  const lotsAfterStocktake = (await call('/inventory/lots')).body.items || [];
  const sourceAfterStocktake = lotsAfterStocktake.find((l) => l.batchCode === 'BATCH-001' && l.location === '主仓') || {};

  // 仪表盘汇总：只断言形状与下限——冒烟自身建了 2 单（1 已完成、1 已取消），
  // 其余绝对值会随种子变化，不写死
  const overview = await call('/dashboard/overview');
  const report = await call('/dashboard/report?range=7d');
  const financeSummary = await call('/dashboard/finance-summary');
  const todos = await call('/dashboard/todos?page=1&pageSize=2');
  const receivables = await call('/dashboard/receivables?page=1&pageSize=2');
  const payables = await call('/dashboard/payables?page=1&pageSize=2');
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
    spusListed: spus.status === 200 && (spus.body.items || []).length >= 1,
    skuCreated: skuCreated.status === 201 && skuCreated.body.code === 'SKU-SMOKE' && skuCreated.body.enabled === true,
    skuDuplicateRejected: skuDuplicate.status === 409 && skuDuplicate.body.code === 'CONFLICT',
    pricesListed: prices.status === 200 && Array.isArray(prices.body.items) && (prices.body.items || []).length >= 2,
    priceCreated: priceCreated.status === 201 && priceCreated.body.price && priceCreated.body.price.amount === 31900,
    principalCreated: principalCreated.status === 201 && principalCreated.body.username === 'smoke',
    smokeLogin: smokeLogin.status === 201 && Boolean(smokeLogin.body.accessToken),
    principalsListed: principals.status === 200 && principals.body.total >= 4,
    customersList: customers.status === 200 && Array.isArray(customers.body.items),
    customerCreated: newCustomer.status === 201 && newCustomer.body.code === 'CUST-SMOKE' && newCustomer.body.totalSpent && newCustomer.body.totalSpent.amount === 0,
    customerTotalSpent: gotCustomer.status === 200 && gotCustomer.body.totalSpent && typeof gotCustomer.body.totalSpent.amount === 'number',
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
    dashboardPayablesPaged: payables.status === 200 && Array.isArray(payables.body.items),
    dashboardActivity: activity.status === 200 && Array.isArray(activity.body) && activity.body.length >= 2,
    dashboardMovementsPaged: movements.status === 200 && movements.body.total >= 1 && (movements.body.items || []).length <= 2,
    rmaListed: rmaList.status === 200 && Array.isArray(rmaList.body.items),
    rmaCreated: rmaCreated.status === 201 && rmaCreated.body.status === 'requested' && rmaCreated.body.refundAmount && rmaCreated.body.refundAmount.amount === 19900,
    rmaApproved: rmaApproved.body.status === 'approved',
    rmaReceived: rmaReceived.body.status === 'received' && Boolean(rmaReceived.body.receivedAt),
    rmaRestocked: lotAfterRma.availableQty === lotCancelled.availableQty + 1 && lotAfterRma.totalQty === lotCancelled.totalQty + 1,
    rmaRefunded: rmaRefunded.body.status === 'refunded',
    rmaOverRejected: rmaOver.status === 409 && rmaOver.body.code === 'CONFLICT',
    transferListed: transfersList.status === 200 && Array.isArray(transfersList.body.items),
    stocktakeListed: stocktakesList.status === 200 && Array.isArray(stocktakesList.body.items),
    transferCreated: transferCreated.status === 201 && transferCreated.body.status === 'draft' && transferCreated.body.batchCode === null,
    transferCompleted: transferCompleted.body.status === 'completed' && transferCompleted.body.batchCode === 'BATCH-001' && sourceAfterTransfer.availableQty === lotAfterRma.availableQty - 2 && destAfterTransfer.availableQty === 2 && destAfterTransfer.totalQty === 2,
    stocktakeCreated: stocktakeCreated.status === 201 && stocktakeCreated.body.status === 'draft' && stocktakeCreated.body.systemQty === sourceAfterTransfer.totalQty && stocktakeCreated.body.difference === -1,
    stocktakeConfirmed: stocktakeConfirmed.body.status === 'confirmed' && sourceAfterStocktake.totalQty === sourceAfterTransfer.totalQty - 1 && sourceAfterStocktake.availableQty === sourceAfterTransfer.totalQty - 1,
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
