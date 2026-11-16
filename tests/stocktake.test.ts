import { describe, expect, it } from "vitest"
import { SalesService } from "../src/application/sales.service"
import { StocktakeService } from "../src/application/stocktake.service"
import { DomainError } from "../src/domain/ports"
import { InMemoryDatabase } from "../src/infrastructure/in-memory.database"
import { MockPaymentGateway } from "../src/infrastructure/mock-payment.gateway"

function makeServices() {
  const db = new InMemoryDatabase()
  return {
    db,
    sales: new SalesService(db, new MockPaymentGateway()),
    stocktake: new StocktakeService(db),
  }
}

async function firstSku(db: InMemoryDatabase) {
  const sku = (await db.listSkus({ page: 1, pageSize: 20 })).items[0]
  if (!sku) throw new Error("演示数据缺少 SKU")
  return sku
}

async function firstLot(db: InMemoryDatabase) {
  const lot = (await db.listLots({ page: 1, pageSize: 20 })).items[0]
  if (!lot) throw new Error("演示数据缺少批次")
  return lot
}

describe("StocktakeService", () => {
  it("建单成功：systemQty 为建单时批次总量快照，difference 服务端算对，状态草稿", async () => {
    const { db, stocktake } = makeServices()
    const lot = await firstLot(db)
    expect(lot.totalQty).toBe(100)

    const created = await stocktake.createStocktake({ lotId: lot.id, countedQty: 98 })
    expect(created.status).toBe("draft")
    expect(created.stocktakeNo.startsWith("STK-")).toBe(true)
    expect(created.systemQty).toBe(100)
    expect(created.difference).toBe(-2)
    expect(created.confirmedAt).toBeNull()

    // 建单不动库存
    const after = await db.findLot(lot.id)
    expect(after!.totalQty).toBe(100)
    expect(after!.availableQty).toBe(100)
    const found = await stocktake.findStocktake(created.id)
    expect(found.stocktakeNo).toBe(created.stocktakeNo)
  })

  it("批次不存在报 404", async () => {
    const { stocktake } = makeServices()
    await expect(
      stocktake.createStocktake({ lotId: "00000000-0000-4000-8000-000000000999", countedQty: 10 })
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
  })

  it("确认盘点：盘亏落账总量与可用同步减少，记确认时间，终态不可再动", async () => {
    const { db, stocktake } = makeServices()
    const lot = await firstLot(db)

    const created = await stocktake.createStocktake({ lotId: lot.id, countedQty: 98 })
    const done = await stocktake.confirmStocktake(created.id)
    expect(done.status).toBe("confirmed")
    expect(done.confirmedAt).not.toBeNull()

    const after = await db.findLot(lot.id)
    expect(after!.totalQty).toBe(98)
    expect(after!.availableQty).toBe(98)
    expect(after!.reservedQty).toBe(0)

    await expect(stocktake.confirmStocktake(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })
    await expect(stocktake.cancelStocktake(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })
  })

  it("确认盘点：盘盈落账总量与可用同步增加", async () => {
    const { db, stocktake } = makeServices()
    const lot = await firstLot(db)

    const created = await stocktake.createStocktake({ lotId: lot.id, countedQty: 105 })
    expect(created.difference).toBe(5)
    await stocktake.confirmStocktake(created.id)

    const after = await db.findLot(lot.id)
    expect(after!.totalQty).toBe(105)
    expect(after!.availableQty).toBe(105)
    expect(after!.reservedQty).toBe(0)
  })

  it("实盘小于占用时占用随实盘下调：总量按实盘改，不变量始终成立", async () => {
    const { db, sales, stocktake } = makeServices()
    const sku = await firstSku(db)
    // 先下一单占 3 件：BATCH-001 可用 97、占用 3、总量 100
    await sales.createOrder({ lines: [{ skuId: sku.id, quantity: 3 }] })
    const lot = await firstLot(db)
    expect(lot.availableQty).toBe(97)
    expect(lot.reservedQty).toBe(3)
    expect(lot.totalQty).toBe(100)

    // 实盘只剩 2 件，小于已占用 3 件
    const created = await stocktake.createStocktake({ lotId: lot.id, countedQty: 2 })
    expect(created.difference).toBe(-98)
    await stocktake.confirmStocktake(created.id)

    const after = await db.findLot(lot.id)
    expect(after!.totalQty).toBe(2)
    expect(after!.availableQty).toBe(0)
    expect(after!.reservedQty).toBe(2)
    // 实盘数为准：占用下调到 2，多占的 1 件被释放；total = available + reserved
    // 的不变量始终成立，订单短缺在履约时暴露，而不是留总量 < 占用的坏账
  })

  it("取消不动库存；查不到的盘点单报 404；列表分页与倒序", async () => {
    const { db, stocktake } = makeServices()
    const lot = await firstLot(db)
    const created = await stocktake.createStocktake({ lotId: lot.id, countedQty: 90 })
    const cancelled = await stocktake.cancelStocktake(created.id)
    expect(cancelled.status).toBe("cancelled")
    expect((await db.findLot(lot.id))!.totalQty).toBe(100)
    await expect(stocktake.confirmStocktake(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })

    await expect(stocktake.findStocktake("00000000-0000-4000-8000-000000000999")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
    await expect(stocktake.confirmStocktake("00000000-0000-4000-8000-000000000999")).rejects.toBeInstanceOf(DomainError)

    const a = await stocktake.createStocktake({ lotId: lot.id, countedQty: 99 })
    const b = await stocktake.createStocktake({ lotId: lot.id, countedQty: 101 })
    const page = await stocktake.listStocktakes({ page: 1, pageSize: 1 })
    expect(page.total).toBe(4)
    expect(page.items).toHaveLength(1)
    // 三单同毫秒创建时 createdAt 相同，列表只保证“新三单在前、种子在后”，
    // 不保证三单内部谁第一：CI 快机器上三单同毫秒是常态，旧断言
    //（首页必为 a 或 b）在此时会把已取消的 created 排到第一而挂掉（flaky，
    // 2026-11-16 18:17 CI #26 因此失败，本地 69/69 是撞上了毫秒边界）。
    expect([created.id, a.id, b.id]).toContain(page.items[0]!.id)
    const all = await stocktake.listStocktakes({ page: 1, pageSize: 20 })
    expect(all.items.map((x) => x.id)).toContain(a.id)
    expect(all.items.map((x) => x.id)).toContain(b.id)
    expect(all.items.slice(0, 3).map((x) => x.id).sort()).toEqual([created.id, a.id, b.id].sort())
    // 演示种子 STK-DEMO-001 的创建时间是当天 00:00，最旧，排在最后
    expect(all.items[all.items.length - 1]!.stocktakeNo).toBe("STK-DEMO-001")
  })
})
