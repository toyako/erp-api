import { describe, expect, it } from "vitest"
import { DashboardService } from "../src/application/dashboard.service"
import { PurchaseService } from "../src/application/purchase.service"
import { SalesService, TENANT_ID } from "../src/application/sales.service"
import { StocktakeService } from "../src/application/stocktake.service"
import { TransferService } from "../src/application/transfer.service"
import { InMemoryDatabase } from "../src/infrastructure/in-memory.database"
import { MockPaymentGateway } from "../src/infrastructure/mock-payment.gateway"

function makeDashboard() {
  const db = new InMemoryDatabase()
  const sales = new SalesService(db, new MockPaymentGateway())
  const purchase = new PurchaseService(db)
  return { db, sales, purchase, dashboard: new DashboardService(db) }
}

async function firstSku(db: InMemoryDatabase) {
  const sku = (await db.listSkus({ page: 1, pageSize: 20 })).items[0]
  if (!sku) throw new Error("演示数据缺少 SKU")
  return sku
}

async function secondSku(db: InMemoryDatabase) {
  const sku = (await db.listSkus({ page: 1, pageSize: 20 })).items[1]
  if (!sku) throw new Error("演示数据缺少第二个 SKU")
  return sku
}

/** 5 张订单：fulfilled / confirmed / draft / paid / cancelled 各一 */
async function seedOrders(sales: SalesService, db: InMemoryDatabase) {
  const a = await firstSku(db)
  const b = await secondSku(db)
  const fulfilled = await sales.createOrder({ lines: [{ skuId: a.id, quantity: 2 }] })
  await sales.confirmOrder(fulfilled.id)
  await sales.payOrder(fulfilled.id)
  await sales.fulfillOrder(fulfilled.id)
  const confirmed = await sales.createOrder({ lines: [{ skuId: b.id, quantity: 1 }] })
  await sales.confirmOrder(confirmed.id)
  const draft = await sales.createOrder({ lines: [{ skuId: a.id, quantity: 1 }] })
  const paid = await sales.createOrder({ lines: [{ skuId: b.id, quantity: 1 }] })
  await sales.confirmOrder(paid.id)
  await sales.payOrder(paid.id)
  const cancelled = await sales.createOrder({ lines: [{ skuId: a.id, quantity: 1 }] })
  await sales.cancelOrder(cancelled.id)
  return { fulfilled, confirmed, draft, paid, cancelled }
}

async function seedPurchaseOrders(purchase: PurchaseService, db: InMemoryDatabase) {
  const a = await firstSku(db)
  const b = await secondSku(db)
  await db.saveSupplier({ id: "00000000-0000-4000-8000-000000000501", tenantId: TENANT_ID, code: "SUP-001", name: "测试供应商", rating: 5, enabled: true })
  const supplierId = "00000000-0000-4000-8000-000000000501"
  const draftPo = await purchase.createPurchaseOrder({ supplierId, lines: [{ skuId: a.id, quantity: 1 }] })
  const receivedPo = await purchase.createPurchaseOrder({ supplierId, lines: [{ skuId: b.id, quantity: 1 }] })
  await purchase.submitPurchaseOrder(receivedPo.id)
  await purchase.receivePurchaseOrder(receivedPo.id)
  const submittedPo = await purchase.createPurchaseOrder({ supplierId, lines: [{ skuId: a.id, quantity: 1 }] })
  await purchase.submitPurchaseOrder(submittedPo.id)
  return { draftPo, receivedPo, submittedPo }
}

describe("DashboardService", () => {
  it("概览求和与排行、趋势、低库存、首个 SKU", async () => {
    const { sales, db, dashboard } = makeDashboard()
    await seedOrders(sales, db)
    const o = await dashboard.getOverview()

    expect(o.salesAmount).toBe(119500)
    expect(o.orderCount).toBe(5)
    expect(o.fulfilledCount).toBe(1)
    expect(o.availableStock).toBe(145)
    expect(o.reservedStock).toBe(3)
    expect(o.warningCount).toBe(0)
    expect(o.statusDist).toHaveLength(5)
    expect(o.statusDist.find((s) => s.status === "draft")?.count).toBe(1)
    expect(o.trend7).toHaveLength(7)
    expect(o.trend7.reduce((n, d) => n + d.amount, 0)).toBe(119500)
    expect(o.trend7[6].amount).toBe(119500)
    expect(o.ranking).toHaveLength(2)
    expect(o.ranking[0]).toMatchObject({ code: "SKU-001", qty: 3 })
    expect(o.ranking[1]).toMatchObject({ code: "SKU-002", qty: 2 })
    expect(o.lowStock.map((l) => l.batchCode)).toEqual(["BATCH-002", "BATCH-001"])
    expect(o.lowStock[0]).toMatchObject({ skuCode: "SKU-002", availableQty: 48 })
    expect(o.firstSku).toMatchObject({ code: "SKU-001" })
  })

  it("报表桶求和、排行金额与环比、周转天数、滞销", async () => {
    const { sales, db, dashboard } = makeDashboard()
    await seedOrders(sales, db)
    const r = await dashboard.getReport("7d")

    expect(r.range).toBe("7d")
    expect(r.buckets).toHaveLength(6)
    expect(r.buckets.reduce((n, b) => n + b.amount, 0)).toBe(119500)
    expect(r.buckets[3].amount).toBe(119500)
    expect(r.ranking).toHaveLength(2)
    expect(r.ranking[0]).toMatchObject({ code: "SKU-002", qty: 2, amount: 59800, change: null })
    expect(r.ranking[1]).toMatchObject({ code: "SKU-001", qty: 3, amount: 59700, change: null })
    expect(r.turnover).toHaveLength(2)
    expect(r.turnover[0]).toMatchObject({ name: "SKU-002 · 专业版", stock: 50, days: 175, pct: 77 })
    expect(r.turnover[1]).toMatchObject({ name: "SKU-001 · 标准版", stock: 98, days: 228.7, pct: 100 })
    expect(r.slow).toEqual([])

    const r30 = await dashboard.getReport("30d")
    expect(r30.buckets.reduce((n, b) => n + b.amount, 0)).toBe(119500)
    const rm = await dashboard.getReport("month")
    expect(rm.buckets.reduce((n, b) => n + b.amount, 0)).toBe(119500)
  })

  it("待办派生、过滤与分页", async () => {
    const { sales, db, dashboard } = makeDashboard()
    const { paid, confirmed, draft } = await seedOrders(sales, db)

    const all = await dashboard.listTodos({ page: 1, pageSize: 20 })
    expect(all.total).toBe(8)
    expect(all.items.slice(0, 6).every((i) => !i.done)).toBe(true)
    expect(all.items.slice(6).every((i) => i.done)).toBe(true)
    expect(all.items.find((i) => i.id === `ship-${paid.id}`)).toMatchObject({ type: "order", cls: "blue", action: "去发货" })
    expect(all.items.find((i) => i.id === `pay-${confirmed.id}`)).toMatchObject({ type: "order", cls: "orange", action: "去收款" })
    expect(all.items.find((i) => i.id === `confirm-${draft.id}`)).toMatchObject({ type: "order", cls: "orange", action: "去确认" })
    // 演示种子里的待审核退货单也有一条待办
    expect(all.items.find((i) => i.type === "rma")).toMatchObject({ typeLabel: "退货", cls: "orange", title: "退货待审核", refNo: "RMA-DEMO-001", done: false, action: "去审核", to: "/erp/sales/rma" })
    // 演示种子里的待提交调拨与待确认盘点各有一条待办（TRF-DEMO-001 为草稿态）
    expect(all.items.find((i) => i.type === "transfer")).toMatchObject({ typeLabel: "调拨", cls: "blue", title: "调拨待提交", refNo: "TRF-DEMO-001", done: false, action: "去提交", to: "/erp/stock/transfer" })
    expect(all.items.find((i) => i.type === "stocktake")).toMatchObject({ typeLabel: "盘点", cls: "orange", title: "盘点待确认", refNo: "STK-DEMO-001", done: false, action: "去确认", to: "/erp/stock/transfer" })

    expect((await dashboard.listTodos({ page: 1, pageSize: 20, type: "order" })).total).toBe(3)
    expect((await dashboard.listTodos({ page: 1, pageSize: 20, type: "rma" })).total).toBe(1)
    expect((await dashboard.listTodos({ page: 1, pageSize: 20, type: "transfer" })).total).toBe(1)
    expect((await dashboard.listTodos({ page: 1, pageSize: 20, type: "stocktake" })).total).toBe(1)
    expect((await dashboard.listTodos({ page: 1, pageSize: 20, type: "notice" })).total).toBe(2)
    expect((await dashboard.listTodos({ page: 1, pageSize: 20, status: "pending" })).total).toBe(6)
    expect((await dashboard.listTodos({ page: 1, pageSize: 20, status: "done" })).total).toBe(2)
    expect((await dashboard.listTodos({ page: 1, pageSize: 20, keyword: "待发货" })).total).toBe(1)

    const p1 = await dashboard.listTodos({ page: 1, pageSize: 2 })
    const p3 = await dashboard.listTodos({ page: 3, pageSize: 2 })
    expect(p1.items).toHaveLength(2)
    expect(p1.total).toBe(8)
    expect(p3.items).toHaveLength(2)
  })

  it("应收应付四数", async () => {
    const { sales, purchase, db, dashboard } = makeDashboard()
    await seedOrders(sales, db)
    await seedPurchaseOrders(purchase, db)
    const f = await dashboard.getFinanceSummary()

    expect(f.receivable).toBe(29900)
    expect(f.payable).toBe(39800)
    expect(f.receivedThisMonth).toBe(69700)
    expect(f.paidThisMonth).toBe(29900)
  })

  it("应收行只含已确认及以上状态，已结清与未核销分开", async () => {
    const { sales, db, dashboard } = makeDashboard()
    const { fulfilled, confirmed, paid } = await seedOrders(sales, db)
    const page = await dashboard.listReceivables({ page: 1, pageSize: 20 })

    expect(page.total).toBe(3)
    const byId = new Map(page.items.map((r) => [r.id, r]))
    expect(byId.get(fulfilled.id)).toMatchObject({ settled: 39800, unsettled: 0 })
    expect(byId.get(confirmed.id)).toMatchObject({ settled: 0, unsettled: 29900 })
    expect(byId.get(paid.id)).toMatchObject({ settled: 29900, unsettled: 0 })
    expect(page.items.every((r) => r.currency === "CNY")).toBe(true)

    const p2 = await dashboard.listReceivables({ page: 2, pageSize: 2 })
    expect(p2.items).toHaveLength(1)
    expect(p2.total).toBe(3)
  })

  it("应付行只含草稿/已提交/已入库采购单，已付与未付分开", async () => {
    const { purchase, db, dashboard } = makeDashboard()
    const { draftPo, receivedPo, submittedPo } = await seedPurchaseOrders(purchase, db)
    const page = await dashboard.listPayables({ page: 1, pageSize: 20 })

    expect(page.total).toBe(3)
    const byId = new Map(page.items.map((r) => [r.id, r]))
    expect(byId.get(draftPo.id)).toMatchObject({ orderNo: draftPo.orderNo, status: "draft", amount: 19900, settled: 0, unsettled: 19900 })
    expect(byId.get(submittedPo.id)).toMatchObject({ orderNo: submittedPo.orderNo, status: "submitted", amount: 19900, settled: 0, unsettled: 19900 })
    expect(byId.get(receivedPo.id)).toMatchObject({ orderNo: receivedPo.orderNo, status: "received", amount: 29900, settled: 29900, unsettled: 0 })
    expect(page.items.every((r) => r.currency === "CNY")).toBe(true)

    const p2 = await dashboard.listPayables({ page: 2, pageSize: 2 })
    expect(p2.items).toHaveLength(1)
    expect(p2.total).toBe(3)
  })

  it("采购待办：只有已提交采购单进待办，草稿与已入库不进", async () => {
    const { purchase, db, dashboard } = makeDashboard()
    const { draftPo, receivedPo, submittedPo } = await seedPurchaseOrders(purchase, db)

    const all = await dashboard.listTodos({ page: 1, pageSize: 20, type: "purchase" })
    expect(all.total).toBe(1)
    expect(all.items[0]).toMatchObject({ type: "purchase", typeLabel: "采购", title: "采购单待入库", refNo: submittedPo.orderNo, done: false, action: "去入库", to: "/erp/purchase/orders" })

    const pending = await dashboard.listTodos({ page: 1, pageSize: 20, status: "pending" })
    // 单号防撞：三单同一毫秒建，orderNo 仍必不重（doc-no 进程内同毫秒去重），按单号与待办 id 双断言
    const purchaseIds = pending.items.filter((i) => i.type === "purchase").map((i) => i.id)
    expect(purchaseIds).toEqual([`po-${submittedPo.id}`])
    expect(purchaseIds).not.toContain(`po-${draftPo.id}`)
    expect(purchaseIds).not.toContain(`po-${receivedPo.id}`)
    const purchaseRefNos = pending.items.filter((i) => i.type === "purchase").map((i) => i.refNo)
    expect(purchaseRefNos).toEqual([submittedPo.orderNo])
    expect(purchaseRefNos).not.toContain(draftPo.orderNo)
    expect(purchaseRefNos).not.toContain(receivedPo.orderNo)
    expect(new Set([draftPo.orderNo, receivedPo.orderNo, submittedPo.orderNo]).size).toBe(3)
  })

  it("最近活动取前 5 单", async () => {
    const { sales, db, dashboard } = makeDashboard()
    const { fulfilled } = await seedOrders(sales, db)
    const logs = await dashboard.getRecentActivity()

    expect(logs).toHaveLength(5)
    expect(logs.every((l) => l.text.startsWith("创建销售订单 ERP-"))).toBe(true)
    expect(logs.find((l) => l.text === `创建销售订单 ${fulfilled.orderNo}`)).toBeDefined()
  })

  it("流水派生：履约出库、未履约占用、取消跳过，过滤与分页", async () => {
    const { sales, db, dashboard } = makeDashboard()
    await seedOrders(sales, db)

    const all = await dashboard.listMovements({ page: 1, pageSize: 20 })
    expect(all.total).toBe(4)
    const outbound = all.items.filter((r) => r.type === "outbound")
    expect(outbound).toHaveLength(1)
    expect(outbound[0]).toMatchObject({ batch: "BATCH-001", skuName: "SKU-001 · 标准版", delta: -2 })
    expect(all.items.filter((r) => r.type === "reserve")).toHaveLength(3)

    expect((await dashboard.listMovements({ page: 1, pageSize: 20, type: "outbound" })).total).toBe(1)
    expect((await dashboard.listMovements({ page: 1, pageSize: 20, keyword: "BATCH-002" })).total).toBe(2)
    const p2 = await dashboard.listMovements({ page: 2, pageSize: 3 })
    expect(p2.items).toHaveLength(1)
    expect(p2.total).toBe(4)
  })

  it("流水派生：调拨出库+入库两条、盘点差异一条，零差异不记", async () => {
    const { db, dashboard } = makeDashboard()
    const transfer = new TransferService(db)
    const stocktake = new StocktakeService(db)
    const a = await firstSku(db)

    // 调拨 SKU-001 主仓→华东仓 5 件，走完提交→审核→完成
    const t = await transfer.createTransfer({ skuId: a.id, fromLocation: "主仓", toLocation: "华东仓", quantity: 5 })
    await transfer.submitTransfer(t.id)
    await transfer.approveTransfer(t.id)
    await transfer.completeTransfer(t.id)
    // 盘点 BATCH-002（SKU-002，50 件）实盘 48，确认；再盘一次实盘 48，零差异不记流水
    const lotB = (await db.listLots({ page: 1, pageSize: 20 })).items.find((l) => l.batchCode === "BATCH-002")!
    const s = await stocktake.createStocktake({ lotId: lotB.id, countedQty: 48 })
    await stocktake.confirmStocktake(s.id)
    const s0 = await stocktake.createStocktake({ lotId: lotB.id, countedQty: 48 })
    await stocktake.confirmStocktake(s0.id)

    const all = await dashboard.listMovements({ page: 1, pageSize: 20 })
    expect(all.total).toBe(3)
    const trf = all.items.filter((r) => r.type === "transfer")
    expect(trf).toHaveLength(2)
    expect(trf.find((r) => r.typeLabel === "调拨出库")).toMatchObject({ batch: "BATCH-001", delta: -5, refNo: t.transferNo })
    expect(trf.find((r) => r.typeLabel === "调拨入库")).toMatchObject({ batch: "BATCH-001", delta: 5, refNo: t.transferNo })
    const adj = all.items.filter((r) => r.type === "adjust")
    expect(adj).toHaveLength(1)
    expect(adj[0]).toMatchObject({ batch: "BATCH-002", delta: -2, refNo: s.stocktakeNo })
    expect((await dashboard.listMovements({ page: 1, pageSize: 20, type: "transfer" })).total).toBe(2)
    expect((await dashboard.listMovements({ page: 1, pageSize: 20, type: "adjust" })).total).toBe(1)
  })
})
