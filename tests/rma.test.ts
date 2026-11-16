import { describe, expect, it } from "vitest"
import { RmaService } from "../src/application/rma.service"
import { SalesService } from "../src/application/sales.service"
import { DomainError } from "../src/domain/ports"
import { InMemoryDatabase } from "../src/infrastructure/in-memory.database"
import { MockPaymentGateway } from "../src/infrastructure/mock-payment.gateway"

function makeServices() {
  const db = new InMemoryDatabase()
  return {
    db,
    sales: new SalesService(db, new MockPaymentGateway()),
    rma: new RmaService(db),
  }
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

/** 建单→确认→收款→履约，走完一单已发货订单 */
async function fulfilledOrder(db: InMemoryDatabase, sales: SalesService, skuId: string, quantity: number) {
  const order = await sales.createOrder({ lines: [{ skuId, quantity }] })
  await sales.confirmOrder(order.id)
  await sales.payOrder(order.id)
  await sales.fulfillOrder(order.id)
  return order
}

describe("RmaService", () => {
  it("建单成功，退款金额服务端算对，状态待审核，单号 RMA- 开头", async () => {
    const { db, sales, rma } = makeServices()
    const sku = await firstSku(db)
    const order = await fulfilledOrder(db, sales, sku.id, 2)

    const created = await rma.createRma({ orderId: order.id, skuId: sku.id, quantity: 2, reason: "质量问题" })
    expect(created.status).toBe("requested")
    expect(created.rmaNo.startsWith("RMA-")).toBe(true)
    expect(created.refundAmount).toEqual({ amount: 39800, currency: "CNY" })
    expect(created.receivedAt).toBeNull()

    const found = await rma.findRma(created.id)
    expect(found.rmaNo).toBe(created.rmaNo)
  })

  it("非已发货订单建单报 409：草稿与已收款未发货都不行", async () => {
    const { db, sales, rma } = makeServices()
    const sku = await firstSku(db)
    const draft = await sales.createOrder({ lines: [{ skuId: sku.id, quantity: 1 }] })
    await expect(
      rma.createRma({ orderId: draft.id, skuId: sku.id, quantity: 1, reason: "坏了" })
    ).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })

    await sales.confirmOrder(draft.id)
    await sales.payOrder(draft.id)
    await expect(
      rma.createRma({ orderId: draft.id, skuId: sku.id, quantity: 1, reason: "坏了" })
    ).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })

    await expect(
      rma.createRma({ orderId: "00000000-0000-4000-8000-000000000999", skuId: sku.id, quantity: 1, reason: "坏了" })
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
  })

  it("SKU 不在订单里报 400", async () => {
    const { db, sales, rma } = makeServices()
    const a = await firstSku(db)
    const b = await secondSku(db)
    const order = await fulfilledOrder(db, sales, a.id, 1)
    await expect(
      rma.createRma({ orderId: order.id, skuId: b.id, quantity: 1, reason: "发错货" })
    ).rejects.toMatchObject({ code: "INVALID_STATE", status: 400 })
  })

  it("requested 不占余量，approved 占余量，超余量报 409", async () => {
    const { db, sales, rma } = makeServices()
    const sku = await firstSku(db)
    const order = await fulfilledOrder(db, sales, sku.id, 2)

    // 两单 requested 各 2 件都不超（requested 不占余量）
    const first = await rma.createRma({ orderId: order.id, skuId: sku.id, quantity: 2, reason: "甲" })
    await rma.createRma({ orderId: order.id, skuId: sku.id, quantity: 2, reason: "乙" })

    // 审核通过第二单后余量归零，再建 1 件就超了
    const second = (await rma.listRmas({ page: 1, pageSize: 20 })).items.find((x) => x.reason === "乙")!
    await rma.approveRma(second.id)
    await expect(
      rma.createRma({ orderId: order.id, skuId: sku.id, quantity: 1, reason: "丙" })
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
    expect(first.status).toBe("requested")
  })

  it("取消的不占余量：取消后可退额度回来", async () => {
    const { db, sales, rma } = makeServices()
    const sku = await firstSku(db)
    const order = await fulfilledOrder(db, sales, sku.id, 2)

    const cancelled = await rma.createRma({ orderId: order.id, skuId: sku.id, quantity: 2, reason: "不想要了" })
    await rma.cancelRma(cancelled.id)
    const again = await rma.createRma({ orderId: order.id, skuId: sku.id, quantity: 2, reason: "重新申请" })
    expect(again.status).toBe("requested")
  })

  it("审核→收货回补库存并记 receivedAt→退款，终态不可再动", async () => {
    const { db, sales, rma } = makeServices()
    const sku = await firstSku(db)
    const order = await fulfilledOrder(db, sales, sku.id, 2)
    const lotBefore = (await db.listLots({ page: 1, pageSize: 20 })).items.find((l) => l.skuId === sku.id)!

    const created = await rma.createRma({ orderId: order.id, skuId: sku.id, quantity: 1, reason: "质量问题" })
    // 未审核直接收货报 409
    await expect(rma.receiveRma(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })

    const approved = await rma.approveRma(created.id)
    expect(approved.status).toBe("approved")
    const received = await rma.receiveRma(created.id)
    expect(received.status).toBe("received")
    expect(received.receivedAt).not.toBeNull()

    const lotAfter = (await db.listLots({ page: 1, pageSize: 20 })).items.find((l) => l.skuId === sku.id)!
    expect(lotAfter.availableQty).toBe(lotBefore.availableQty + 1)
    expect(lotAfter.totalQty).toBe(lotBefore.totalQty + 1)
    expect(lotAfter.reservedQty).toBe(lotBefore.reservedQty)

    const refunded = await rma.refundRma(created.id)
    expect(refunded.status).toBe("refunded")
    await expect(rma.approveRma(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })
    await expect(rma.receiveRma(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })
    await expect(rma.cancelRma(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })
  })

  it("拒绝后终态不可再动", async () => {
    const { db, sales, rma } = makeServices()
    const sku = await firstSku(db)
    const order = await fulfilledOrder(db, sales, sku.id, 1)
    const created = await rma.createRma({ orderId: order.id, skuId: sku.id, quantity: 1, reason: "不想要了" })
    const rejected = await rma.rejectRma(created.id)
    expect(rejected.status).toBe("rejected")
    await expect(rma.approveRma(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })
    await expect(rma.cancelRma(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })
  })

  it("收货时该 SKU 无批次则新建批次（batchCode 取退货单号）", async () => {
    const { db, rma } = makeServices()
    // 直接存一单已发货订单：新 SKU 无批次、无价格，不走建单校验
    const newSkuId = "00000000-0000-4000-8000-000000000103"
    await db.saveSku({ id: newSkuId, spuId: "00000000-0000-4000-8000-000000000100", code: "SKU-003", spec: "测试版", unit: "件", enabled: true })
    await db.saveOrder({
      id: "00000000-0000-4000-8000-000000000501",
      tenantId: "00000000-0000-4000-8000-000000000001",
      orderNo: "ERP-TEST-NOLOT",
      status: "fulfilled",
      lines: [{ id: "00000000-0000-4000-8000-000000000502", skuId: newSkuId, quantity: 3, unitPrice: { amount: 19900, currency: "CNY" } }],
      total: { amount: 59700, currency: "CNY" },
      createdAt: new Date().toISOString(),
    })
    expect((await db.listLots({ page: 1, pageSize: 20 })).items.some((l) => l.skuId === newSkuId)).toBe(false)

    const created = await rma.createRma({ orderId: "00000000-0000-4000-8000-000000000501", skuId: newSkuId, quantity: 3, reason: "批量退货" })
    await rma.approveRma(created.id)
    await rma.receiveRma(created.id)
    const lot = (await db.listLots({ page: 1, pageSize: 20 })).items.find((l) => l.skuId === newSkuId)!
    expect(lot.batchCode).toBe(created.rmaNo)
    expect(lot.availableQty).toBe(3)
    expect(lot.totalQty).toBe(3)
    expect(lot.reservedQty).toBe(0)
  })

  it("查不到的退货单报 404；列表分页与倒序", async () => {
    const { db, sales, rma } = makeServices()
    const sku = await firstSku(db)
    const order = await fulfilledOrder(db, sales, sku.id, 5)
    await expect(rma.findRma("00000000-0000-4000-8000-000000000999")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
    await expect(rma.approveRma("00000000-0000-4000-8000-000000000999")).rejects.toBeInstanceOf(DomainError)

    const a = await rma.createRma({ orderId: order.id, skuId: sku.id, quantity: 1, reason: "甲" })
    const b = await rma.createRma({ orderId: order.id, skuId: sku.id, quantity: 1, reason: "乙" })
    const page = await rma.listRmas({ page: 1, pageSize: 1 })
    expect(page.total).toBe(3)
    expect(page.items).toHaveLength(1)
    // 新单在前：第一页是后建的甲/乙之一（同毫秒时创建时间相同，顺序不定，只断言是新单）
    expect([a.id, b.id]).toContain(page.items[0]!.id)
    const all = await rma.listRmas({ page: 1, pageSize: 20 })
    expect(all.items.map((x) => x.id)).toContain(a.id)
    expect(all.items.map((x) => x.id)).toContain(b.id)
    // 演示种子 RMA-DEMO-001 的创建时间是当天 00:00，最旧，排在最后
    expect(all.items[all.items.length - 1]!.rmaNo).toBe("RMA-DEMO-001")
  })
})
