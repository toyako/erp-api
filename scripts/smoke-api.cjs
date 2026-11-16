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
  // 鉴权收口后：登录成功后所有调用都带 admin token（/health 与 /auth/login 本身公开，不带也没事）
  const headers = { ...(options?.headers || {}) };
  if (accessToken && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  const r = await fetch(base + path, { ...options, headers });
  let body = {};
  try { body = await r.json(); } catch { /* empty body */ }
  return { status: r.status, body };
}

// admin 登录后取到的 token；smoke 用户登录只验“能登上”，后续调用仍用 admin token
//（sales 调 /iam/principals 会 403）
let accessToken = '';

const jsonPost = (value) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

async function main() {
  await waitReady();

  const health = await call('/health');
  const login = await call('/auth/login', jsonPost({ username: 'admin', password: 'demo1234' }));
  if (!login.body.accessToken) throw new Error('admin login did not return a token');
  accessToken = login.body.accessToken;
  const skus = await call('/products/skus');
  const sku = skus.body.items && skus.body.items[0];
  if (!sku) throw new Error('no seed SKU');
  const skuB = skus.body.items && skus.body.items[1];
  if (!skuB) throw new Error('no second seed SKU');
  const spus = await call('/products/spus');
  const spu = spus.body.items && spus.body.items[0];
  if (!spu) throw new Error('no seed SPU');

  // 新建 SKU：成功 + 编码重复 409；价格档案：列表 + 新建（用 SKU-002，避免改 SKU-001 的定价影响后续订单金额断言）
  const skuCreated = await call('/products/skus', jsonPost({ spuId: spu.id, code: 'SKU-SMOKE', spec: '冒烟版', unit: '套' }));
  const skuDuplicate = await call('/products/skus', jsonPost({ spuId: spu.id, code: 'SKU-SMOKE', spec: '重复', unit: '套' }));
  const prices = await call('/products/prices');
  const priceCreated = await call('/products/prices', jsonPost({ skuId: skuB.id, price: { amount: 31900, currency: 'CNY' } }));

  // 用户管理：新建用户 + 新用户能登录
  const principalCreated = await call('/iam/principals', jsonPost({ username: 'smoke', password: 'smoke123', displayName: '冒烟用户', roles: ['sales'] }));
  const smokeLogin = principalCreated.body.id ? await call('/auth/login', jsonPost({ username: 'smoke', password: 'smoke123' })) : { status: 0, body: {} };
  const principals = await call('/iam/principals');

  const customers = await call('/customers');
  const newCustomer = await call('/customers', jsonPost({ code: 'CUST-SMOKE', name: '冒烟客户', level: 'vip' }));
  const gotCustomer = newCustomer.body.id ? await call(`/customers/${newCustomer.body.id}`) : { status: 0, body: {} };
  const customerSearch = await call('/customers?search=CUST-SMOKE');
  const customerSearchNone = await call('/customers?search=' + encodeURIComponent('不存在'));

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
  // 拒绝带原因：第二单退货（余量剩 1）拒绝成功并落库原因；无原因拒绝报 400
  const rma2Created = await call('/rmas', jsonPost({ orderId: id, skuId: sku.id, quantity: 1, reason: '第二单退货' }));
  const rma2Id = rma2Created.body.id;
  const rma2Rejected = rma2Id ? await call(`/rmas/${rma2Id}/reject`, jsonPost({ reason: '已过退货期限' })) : { status: 0, body: {} };
  const rma3Created = await call('/rmas', jsonPost({ orderId: id, skuId: sku.id, quantity: 1, reason: '第三单退货' }));
  const rma3Id = rma3Created.body.id;
  const rma3RejectNoReason = rma3Id ? await call(`/rmas/${rma3Id}/reject`, { method: 'POST' }) : { status: 0, body: {} };

  // 调拨与盘点闭环：建调拨→提交→审核通过→完成（源批次扣数、目标新建同批次）→建盘点→确认（总量按实盘改）
  const transfersList = await call('/transfers');
  const stocktakesList = await call('/stocktakes');
  const transferCreated = await call('/transfers', jsonPost({ skuId: sku.id, fromLocation: '主仓', toLocation: '华东仓', quantity: 2 }));
  const transferId = transferCreated.body.id;
  const transferSubmitted = transferId ? await call(`/transfers/${transferId}/submit`, { method: 'POST' }) : { status: 0, body: {} };
  const transferApproved = transferId ? await call(`/transfers/${transferId}/approve`, { method: 'POST' }) : { status: 0, body: {} };
  const transferCompleted = transferId ? await call(`/transfers/${transferId}/complete`, { method: 'POST' }) : { status: 0, body: {} };
  const lotsAfterTransfer = (await call('/inventory/lots')).body.items || [];
  const sourceAfterTransfer = lotsAfterTransfer.find((l) => l.batchCode === 'BATCH-001' && l.location === '主仓') || {};
  const destAfterTransfer = lotsAfterTransfer.find((l) => l.batchCode === 'BATCH-001' && l.location === '华东仓') || {};
  const stocktakeCreated = await call('/stocktakes', jsonPost({ lotId: sourceAfterTransfer.id, countedQty: sourceAfterTransfer.totalQty - 1 }));
  const stocktakeId = stocktakeCreated.body.id;
  const stocktakeConfirmed = stocktakeId ? await call(`/stocktakes/${stocktakeId}/confirm`, { method: 'POST' }) : { status: 0, body: {} };
  const lotsAfterStocktake = (await call('/inventory/lots')).body.items || [];
  const sourceAfterStocktake = lotsAfterStocktake.find((l) => l.batchCode === 'BATCH-001' && l.location === '主仓') || {};

  // 发货闭环：新单建单→确认→付款→建发货单→拣货（回填批次）→打包→发货（订单变 fulfilled、库存扣掉）→送达
  const shipOrder = await call('/sales/orders', jsonPost({ lines: [{ skuId: sku.id, quantity: 1 }] }));
  const shipOrderId = shipOrder.body.id;
  const shipOrderConfirmed = shipOrderId ? await call(`/sales/orders/${shipOrderId}/confirm`, { method: 'POST' }) : { status: 0, body: {} };
  const shipOrderPaid = shipOrderId ? await call(`/sales/orders/${shipOrderId}/pay`, { method: 'POST' }) : { status: 0, body: {} };
  const shipmentCreated = shipOrderId ? await call('/shipments', jsonPost({ orderId: shipOrderId })) : { status: 0, body: {} };
  const shipmentId = shipmentCreated.body.id;
  const shipmentPicked = shipmentId ? await call(`/shipments/${shipmentId}/pick`, { method: 'POST' }) : { status: 0, body: {} };
  const shipmentPacked = shipmentId ? await call(`/shipments/${shipmentId}/pack`, { method: 'POST' }) : { status: 0, body: {} };
  const shipmentShipped = shipmentId ? await call(`/shipments/${shipmentId}/ship`, jsonPost({ carrier: '顺丰速运', trackingNo: 'SF1234567890' })) : { status: 0, body: {} };
  const shipOrderList = shipOrderId ? await call('/sales/orders?page=1&pageSize=20') : { status: 0, body: {} };
  const shipOrderAfter = (shipOrderList.body.items || []).find((o) => o.id === shipOrderId) || {};
  const lotsAfterShip = (await call('/inventory/lots')).body.items || [];
  const sourceAfterShip = lotsAfterShip.find((l) => l.batchCode === 'BATCH-001' && l.location === '主仓') || {};
  const shipmentDelivered = shipmentId ? await call(`/shipments/${shipmentId}/deliver`, { method: 'POST' }) : { status: 0, body: {} };
  const shipmentBadShip = shipmentId ? await call(`/shipments/${shipmentId}/ship`, jsonPost({ carrier: '顺丰速运', trackingNo: 'SF2' })) : { status: 0, body: {} };

  // 发票闭环：新单建单→确认→付款→开票 ¥199（草稿）→开票（已开票）→再开 ¥1 超额 409→作废→重开 ¥199 成功
  const invOrder = await call('/sales/orders', jsonPost({ lines: [{ skuId: sku.id, quantity: 1 }] }));
  const invOrderId = invOrder.body.id;
  const invOrderConfirmed = invOrderId ? await call(`/sales/orders/${invOrderId}/confirm`, { method: 'POST' }) : { status: 0, body: {} };
  const invOrderPaid = invOrderId ? await call(`/sales/orders/${invOrderId}/pay`, { method: 'POST' }) : { status: 0, body: {} };
  const invoiceCreated = invOrderId ? await call('/invoices', jsonPost({ orderId: invOrderId, amount: { amount: 19900, currency: 'CNY' } })) : { status: 0, body: {} };
  const invoiceId = invoiceCreated.body.id;
  const invoiceIssued = invoiceId ? await call(`/invoices/${invoiceId}/issue`, { method: 'POST' }) : { status: 0, body: {} };
  const invoiceOver = invOrderId ? await call('/invoices', jsonPost({ orderId: invOrderId, amount: { amount: 100, currency: 'CNY' } })) : { status: 0, body: {} };
  const invoiceVoided = invoiceId ? await call(`/invoices/${invoiceId}/void`, { method: 'POST' }) : { status: 0, body: {} };
  const invoiceRecreated = invOrderId ? await call('/invoices', jsonPost({ orderId: invOrderId, amount: { amount: 19900, currency: 'CNY' } })) : { status: 0, body: {} };

  // 采购深化：建单→提交→审核→部分入库 2/5→收满→入库单两张；驳回须原因
  const supplierCreated = await call('/purchase/suppliers', jsonPost({ code: 'SUP-SMOKE', name: '冒烟供货商', rating: 4 }));
  const supplierId = supplierCreated.body.id;
  const poCreated = supplierId ? await call('/purchase/orders', jsonPost({ supplierId, lines: [{ skuId: sku.id, quantity: 5 }] })) : { status: 0, body: {} };
  const poId = poCreated.body.id;
  const poSubmitted = poId ? await call(`/purchase/orders/${poId}/submit`, { method: 'POST' }) : { status: 0, body: {} };
  const poReceiveEarly = poId ? await call(`/purchase/orders/${poId}/receive`, { method: 'POST' }) : { status: 0, body: {} };
  const poApproved = poId ? await call(`/purchase/orders/${poId}/approve`, { method: 'POST' }) : { status: 0, body: {} };
  const poPartial = poId ? await call(`/purchase/orders/${poId}/receive`, jsonPost({ lines: [{ skuId: sku.id, quantity: 2 }] })) : { status: 0, body: {} };
  const poOver = poId ? await call(`/purchase/orders/${poId}/receive`, jsonPost({ lines: [{ skuId: sku.id, quantity: 4 }] })) : { status: 0, body: {} };
  const poRest = poId ? await call(`/purchase/orders/${poId}/receive`, jsonPost({ lines: [{ skuId: sku.id, quantity: 3 }] })) : { status: 0, body: {} };
  const receipts = poId ? await call(`/purchase/receipts?purchaseOrderId=${poId}&page=1&pageSize=20`) : { status: 0, body: {} };
  const po2Created = supplierId ? await call('/purchase/orders', jsonPost({ supplierId, lines: [{ skuId: sku.id, quantity: 1 }] })) : { status: 0, body: {} };
  const po2Id = po2Created.body.id;
  const po2Submitted = po2Id ? await call(`/purchase/orders/${po2Id}/submit`, { method: 'POST' }) : { status: 0, body: {} };
  const po2RejectEmpty = po2Id ? await call(`/purchase/orders/${po2Id}/reject`, jsonPost({ reason: '' })) : { status: 0, body: {} };
  const po2Rejected = po2Id ? await call(`/purchase/orders/${po2Id}/reject`, jsonPost({ reason: '价格高于市场价' })) : { status: 0, body: {} };

  // 仪表盘汇总：只断言形状与下限——冒烟自身建了 2 单（1 已完成、1 已取消），
  // 其余绝对值会随种子变化，不写死
  const overview = await call('/dashboard/overview');
  const report = await call('/dashboard/report?range=7d');
  const purchaseReport = await call('/dashboard/purchase-report?range=7d');
  const financeSummary = await call('/dashboard/finance-summary');

  // SKU 成本价：PATCH 设 ¥130 再清回 null（验 updateSku 的 cost 合并与 null 清除；token 由 call 自动注入）
  const skuCostSet = sku.id ? await call(`/products/skus/${sku.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cost: { amount: 13000, currency: 'CNY' } }) }) : { status: 0, body: {} };
  const skuCostCleared = sku.id ? await call(`/products/skus/${sku.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cost: null }) }) : { status: 0, body: {} };
  const todos = await call('/dashboard/todos?page=1&pageSize=2');
  const receivables = await call('/dashboard/receivables?page=1&pageSize=2');
  const payables = await call('/dashboard/payables?page=1&pageSize=2');
  const activity = await call('/dashboard/recent-activity');
  const movements = await call('/dashboard/movements?page=1&pageSize=2');

  // 审计日志：写请求已记（建客户等），entity 过滤有效；GET 本身不记（两次查总数不变）
  const auditAll = await call('/audit/events?page=1&pageSize=5');
  const auditCustomers = await call('/audit/events?entity=customers&page=1&pageSize=5');
  const auditAllAgain = await call('/audit/events?page=1&pageSize=5');

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
    customerSearch: customerSearch.status === 200 && customerSearch.body.total === 1 && customerSearch.body.items[0].code === 'CUST-SMOKE',
    customerSearchNone: customerSearchNone.status === 200 && customerSearchNone.body.total === 0,
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
    rmaRejectedWithReason: rma2Rejected.body.status === 'rejected' && rma2Rejected.body.rejectReason === '已过退货期限',
    rmaRejectNoReason: rma3RejectNoReason.status === 400,
    transferListed: transfersList.status === 200 && Array.isArray(transfersList.body.items),
    stocktakeListed: stocktakesList.status === 200 && Array.isArray(stocktakesList.body.items),
    transferCreated: transferCreated.status === 201 && transferCreated.body.status === 'draft' && transferCreated.body.batchCode === null,
    transferSubmitted: transferSubmitted.body.status === 'submitted',
    transferApproved: transferApproved.body.status === 'approved',
    transferCompleted: transferCompleted.body.status === 'completed' && transferCompleted.body.batchCode === 'BATCH-001' && sourceAfterTransfer.availableQty === lotAfterRma.availableQty - 2 && destAfterTransfer.availableQty === 2 && destAfterTransfer.totalQty === 2,
    stocktakeCreated: stocktakeCreated.status === 201 && stocktakeCreated.body.status === 'draft' && stocktakeCreated.body.systemQty === sourceAfterTransfer.totalQty && stocktakeCreated.body.difference === -1,
    stocktakeConfirmed: stocktakeConfirmed.body.status === 'confirmed' && sourceAfterStocktake.totalQty === sourceAfterTransfer.totalQty - 1 && sourceAfterStocktake.availableQty === sourceAfterTransfer.totalQty - 1,
    shipmentCreated: shipmentCreated.status === 201 && shipmentCreated.body.status === 'draft' && shipmentCreated.body.shipmentNo && shipmentCreated.body.shipmentNo.startsWith('SHP-') && Array.isArray(shipmentCreated.body.lines) && shipmentCreated.body.lines[0].batchCode === null,
    shipmentPicked: shipmentPicked.body.status === 'picking' && shipmentPicked.body.lines[0].batchCode === 'BATCH-001',
    shipmentPacked: shipmentPacked.body.status === 'packed',
    shipmentShipped: shipmentShipped.body.status === 'shipped' && shipmentShipped.body.carrier === '顺丰速运' && shipmentShipped.body.trackingNo === 'SF1234567890' && Boolean(shipmentShipped.body.shippedAt),
    shipmentFulfillsOrder: shipOrderAfter.status === 'fulfilled' && sourceAfterShip.totalQty === sourceAfterStocktake.totalQty - 1 && sourceAfterShip.reservedQty === 0 && sourceAfterShip.availableQty === sourceAfterStocktake.availableQty - 1,
    shipmentDelivered: shipmentDelivered.body.status === 'delivered' && Boolean(shipmentDelivered.body.deliveredAt),
    shipmentBadShipRejected: shipmentBadShip.status === 409 && shipmentBadShip.body.code === 'INVALID_STATE',
    invoiceCreated: invoiceCreated.status === 201 && invoiceCreated.body.status === 'draft' && invoiceCreated.body.invoiceNo && invoiceCreated.body.invoiceNo.startsWith('INV-') && invoiceCreated.body.title === '散客' && invoiceCreated.body.amount && invoiceCreated.body.amount.amount === 19900,
    invoiceIssued: invoiceIssued.body.status === 'issued' && Boolean(invoiceIssued.body.issuedAt),
    invoiceOverRejected: invoiceOver.status === 409 && invoiceOver.body.code === 'CONFLICT',
    invoiceVoided: invoiceVoided.body.status === 'voided',
    invoiceRecreated: invoiceRecreated.status === 201 && invoiceRecreated.body.status === 'draft',
    auditRecorded: auditAll.status === 200 && auditAll.body.total >= 1 && (auditAll.body.items || []).every((e) => typeof e.action === 'string' && e.action.length > 0),
    auditEntityFilter: auditCustomers.status === 200 && auditCustomers.body.total >= 1 && (auditCustomers.body.items || []).every((e) => e.targetType === 'customers') && (auditCustomers.body.items || []).some((e) => e.action === 'POST /customers'),
    auditGetNotLogged: auditAllAgain.body.total === auditAll.body.total,
    overviewTrend30: Array.isArray(overview.body.trend30) && overview.body.trend30.length === 30 && Array.isArray(overview.body.trend7) && overview.body.trend7.length === 7,
    reportGross: report.body.gross && Array.isArray(report.body.gross.rows) && typeof report.body.gross.totalAmount === 'number' && (report.body.gross.totalGross === null || typeof report.body.gross.totalGross === 'number'),
    purchaseReport: purchaseReport.status === 200 && Array.isArray(purchaseReport.body.buckets) && purchaseReport.body.buckets.length === 6 && Array.isArray(purchaseReport.body.supplierRanking) && Array.isArray(purchaseReport.body.statusCounts) && purchaseReport.body.statusCounts.length === 7 && (purchaseReport.body.receivedRate === null || typeof purchaseReport.body.receivedRate === 'number'),
    poSubmitted: poSubmitted.body.status === 'submitted',
    poReceiveEarlyRejected: poReceiveEarly.status === 409 && poReceiveEarly.body.code === 'INVALID_STATE',
    poApproved: poApproved.body.status === 'approved',
    poPartial: poPartial.body.order && poPartial.body.order.status === 'partially_received' && poPartial.body.order.lines[0].receivedQty === 2 && poPartial.body.receipt && poPartial.body.receipt.receiptNo && poPartial.body.receipt.receiptNo.startsWith('GRN-') && poPartial.body.receipt.lines[0].quantity === 2,
    poOverRejected: poOver.status === 409 && poOver.body.code === 'CONFLICT',
    poReceived: poRest.body.order && poRest.body.order.status === 'received' && poRest.body.order.lines[0].receivedQty === 5,
    receiptsListed: receipts.body.total === 2 && (receipts.body.items || []).every((r) => r.receiptNo && r.receiptNo.startsWith('GRN-')),
    po2RejectEmpty: po2RejectEmpty.status === 400,
    po2Rejected: po2Rejected.body.status === 'rejected' && po2Rejected.body.rejectReason === '价格高于市场价',
    skuCostSet: skuCostSet.body.cost && skuCostSet.body.cost.amount === 13000,
    skuCostCleared: skuCostCleared.body.cost === null,
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
