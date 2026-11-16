import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { DashboardService } from "../src/application/dashboard.service"
import { PurchaseService } from "../src/application/purchase.service"
import { SalesService } from "../src/application/sales.service"
import { InMemoryDatabase } from "../src/infrastructure/in-memory.database"
import { MockPaymentGateway } from "../src/infrastructure/mock-payment.gateway"

function makeServices() {
  const db = new InMemoryDatabase()
  return {
    db,
    dashboard: new DashboardService(db),
    sales: new SalesService(db, new MockPaymentGateway()),
    purchase: new PurchaseService(db),
  }
}

async function firstSku(db: InMemoryDatabase) {
  const sku = (await db.listSkus({ page: 1, pageSize: 20 })).items[0]
  if (!sku) throw new Error("演示数据缺少 SKU")
  return sku
}

/** 建单→确认→收款，走完一单已付款订单 */
async function paidOrder(db: InMemoryDatabase, sales: SalesService, skuId: string, quantity: number) {
  const order = await sales.createOrder({ lines: [{ skuId, quantity }] })
  await sales.confirmOrder(order.id)
  await sales.payOrder(order.id)
  return order
}

async function makeSupplier(db: InMemoryDatabase, name: string) {
  const supplier = {
    id: randomUUID(),
    tenantId: "00000000-0000-4000-8000-000000000001",
    code: `SUP-${name}`,
    name,
    rating: 4 as const,
    enabled: true,
  }
  await db.saveSupplier(supplier)
  return supplier
}

describe("DashboardService report", () => {
  it("getOverview trend30：30 条逐日、日期连续、最后一天是今天", async () => {
    const { dashboard } = makeServices()
    const overview = await dashboard.getOverview()
    expect(overview.trend30).toHaveLength(30)
    expect(overview.trend7).toHaveLength(7)
    const today = new Date().toISOString().slice(0, 10)
    expect(overview.trend30[29]?.date).toBe(today)
    expect(overview.trend30[0]?.date < overview.trend30[29]?.date).toBe(true)
    for (const t of overview.trend30) expect(t.amount).toBeGreaterThanOrEqual(0)
  })

  it("getReport 毛利：SKU-001 售 ¥199、本 ¥120，×2 毛利 ¥158、毛利率 39.7%", async () => {
    const { db, dashboard, sales } = makeServices()
    const sku = await firstSku(db)
    await paidOrder(db, sales, sku.id, 2)

    const report = await dashboard.getReport("7d")
    const row = report.gross.rows.find((r) => r.skuId === sku.id)
    expect(row).toBeDefined()
    expect(row?.qty).toBe(2)
    expect(row?.amount).toBe(39800)
    expect(row?.cost).toBe(24000)
    expect(row?.gross).toBe(15800)
    expect(row?.marginRate).toBe(39.7)
    expect(report.gross.totalAmount).toBe(39800)
    expect(report.gross.totalCost).toBe(24000)
    expect(report.gross.totalGross).toBe(15800)
    expect(report.gross.marginRate).toBe(39.7)
  })

  it("getReport 毛利：未维护成本价的 SKU 行 gross/marginRate 为 null，汇总只计已维护成本的 SKU", async () => {
    const { db, dashboard, sales } = makeServices()
    const sku = await firstSku(db)
    await paidOrder(db, sales, sku.id, 2)

    const spuId = "00000000-0000-4000-8000-000000000100"
    const bareSku = {
      id: randomUUID(),
      spuId,
      code: "SKU-NOCOST",
      spec: "无成本版",
      unit: "套",
      enabled: true,
      cost: null,
    }
    await db.saveSku(bareSku)
    await db.savePrice({
      id: randomUUID(),
      skuId: bareSku.id,
      channelCode: "DIRECT",
      price: { amount: 10000, currency: "CNY" },
      effectiveFrom: new Date().toISOString(),
    })
    // 下单要占库存：给新 SKU 补一个批次（否则 createOrder 报库存不足）
    await db.saveLot({
      id: randomUUID(),
      tenantId: "00000000-0000-4000-8000-000000000001",
      skuId: bareSku.id,
      batchCode: "BATCH-NOCOST",
      location: "主仓",
      availableQty: 10,
      reservedQty: 0,
      totalQty: 10,
    })
    await paidOrder(db, sales, bareSku.id, 1)

    const report = await dashboard.getReport("7d")
    const bareRow = report.gross.rows.find((r) => r.skuId === bareSku.id)
    expect(bareRow?.amount).toBe(10000)
    expect(bareRow?.cost).toBeNull()
    expect(bareRow?.gross).toBeNull()
    expect(bareRow?.marginRate).toBeNull()
    // 汇总仍只计 SKU-001（未维护成本的 ¥100 销售额不进毛利汇总）
    expect(report.gross.totalAmount).toBe(39800)
    expect(report.gross.totalGross).toBe(15800)
  })

  it("getReport 毛利：有订单但全部未维护成本时汇总为 null", async () => {
    const { db, dashboard, sales } = makeServices()
    const sku = await firstSku(db)
    await paidOrder(db, sales, sku.id, 2)
    // 下单后再清掉全部 SKU 成本价：行还在，但 gross/marginRate 为 null，汇总为 null
    const skus = (await db.listSkus({ page: 1, pageSize: 20 })).items
    for (const s of skus) await db.saveSku({ ...s, cost: null })

    const report = await dashboard.getReport("7d")
    expect(report.gross.rows).toHaveLength(1)
    expect(report.gross.rows[0]?.cost).toBeNull()
    expect(report.gross.rows[0]?.gross).toBeNull()
    expect(report.gross.totalAmount).toBe(0)
    expect(report.gross.totalCost).toBe(0)
    expect(report.gross.totalGross).toBeNull()
    expect(report.gross.marginRate).toBeNull()
  })

  it("getPurchaseReport：供应商排行、状态汇总、到货率", async () => {
    const { db, dashboard, purchase } = makeServices()
    const skuA = (await db.listSkus({ page: 1, pageSize: 20 })).items[0]
    const skuB = (await db.listSkus({ page: 1, pageSize: 20 })).items[1]
    if (!skuA || !skuB) throw new Error("演示数据缺少 SKU")
    const supplier = await makeSupplier(db, "华东供货商")

    const po1 = await purchase.createPurchaseOrder({ supplierId: supplier.id, lines: [{ skuId: skuA.id, quantity: 2 }] })
    await purchase.submitPurchaseOrder(po1.id)
    await purchase.receivePurchaseOrder(po1.id)
    const po2 = await purchase.createPurchaseOrder({ supplierId: supplier.id, lines: [{ skuId: skuB.id, quantity: 1 }] })
    void po2

    const report = await dashboard.getPurchaseReport("7d")
    expect(report.buckets).toHaveLength(6)
    expect(report.supplierRanking).toHaveLength(1)
    expect(report.supplierRanking[0]?.name).toBe("华东供货商")
    expect(report.supplierRanking[0]?.amount).toBe(69700)
    expect(report.supplierRanking[0]?.count).toBe(2)
    const received = report.statusCounts.find((s) => s.status === "received")
    const draft = report.statusCounts.find((s) => s.status === "draft")
    expect(received?.count).toBe(1)
    expect(received?.amount).toBe(39800)
    expect(draft?.count).toBe(1)
    expect(draft?.amount).toBe(29900)
    expect(report.statusCounts).toHaveLength(4)
    expect(report.receivedRate).toBe(57.1)
  })

  it("getPurchaseReport 空库：到货率为 null、排行空、桶全 0", async () => {
    const { dashboard } = makeServices()
    const report = await dashboard.getPurchaseReport("7d")
    expect(report.receivedRate).toBeNull()
    expect(report.supplierRanking).toHaveLength(0)
    expect(report.buckets.every((b) => b.amount === 0)).toBe(true)
    expect(report.statusCounts.every((s) => s.count === 0 && s.amount === 0)).toBe(true)
  })
})
