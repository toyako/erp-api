import { ORDER_TRANSITIONS } from "@erp/contracts"
import { describe, expect, it } from "vitest"
import { addMoney, multiplyMoney, zeroMoney } from "../src/domain/money"
import { canTransition } from "../src/domain/state-machine"
import { SalesService } from "../src/application/sales.service"
import { DomainError } from "../src/domain/ports"
import { InMemoryDatabase } from "../src/infrastructure/in-memory.database"
import { MockPaymentGateway } from "../src/infrastructure/mock-payment.gateway"

function makeService() {
  const db = new InMemoryDatabase()
  return { db, service: new SalesService(db, new MockPaymentGateway()) }
}

async function firstSku(db: InMemoryDatabase) {
  const sku = (await db.listSkus())[0]
  if (!sku) throw new Error("演示数据缺少 SKU")
  return sku
}

describe("金额值对象", () => {
  it("按最小货币单位整数运算", () => {
    expect(multiplyMoney({ amount: 19900, currency: "CNY" }, 2)).toEqual({ amount: 39800, currency: "CNY" })
    expect(addMoney(zeroMoney(), { amount: 500, currency: "CNY" })).toEqual({ amount: 500, currency: "CNY" })
  })

  it("拒绝非正数数量与币种混算", () => {
    expect(() => multiplyMoney({ amount: 100, currency: "CNY" }, 0)).toThrow()
    expect(() => addMoney({ amount: 1, currency: "CNY" }, { amount: 1, currency: "USD" })).toThrow()
  })
})

describe("订单状态机", () => {
  it("允许合法迁移", () => {
    expect(canTransition(ORDER_TRANSITIONS, "draft", "confirmed")).toBe(true)
    expect(canTransition(ORDER_TRANSITIONS, "confirmed", "paid")).toBe(true)
    expect(canTransition(ORDER_TRANSITIONS, "paid", "fulfilled")).toBe(true)
  })

  it("终态不可回退", () => {
    expect(canTransition(ORDER_TRANSITIONS, "fulfilled", "paid")).toBe(false)
    expect(canTransition(ORDER_TRANSITIONS, "cancelled", "confirmed")).toBe(false)
  })
})

describe("SalesService", () => {
  it("金额由价格表计算，下单即占用库存且总量不变", async () => {
    const { db, service } = makeService()
    const sku = await firstSku(db)
    const before = (await db.listLots()).find((lot) => lot.skuId === sku.id)!

    const order = await service.createOrder({ lines: [{ skuId: sku.id, quantity: 2 }] })
    const after = (await db.listLots()).find((lot) => lot.skuId === sku.id)!

    expect(order.total.amount).toBe(39800)
    expect(order.status).toBe("draft")
    expect(after.reservedQty).toBe(before.reservedQty + 2)
    expect(after.availableQty).toBe(before.availableQty - 2)
    expect(after.totalQty).toBe(before.totalQty)
    expect((await service.confirmOrder(order.id)).status).toBe("confirmed")
  })

  it("库存不足时抛领域异常并回滚事务", async () => {
    const { db, service } = makeService()
    const sku = await firstSku(db)
    const before = (await db.listLots()).find((lot) => lot.skuId === sku.id)!

    await expect(
      service.createOrder({ lines: [{ skuId: sku.id, quantity: 99999 }] })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" })

    const after = (await db.listLots()).find((lot) => lot.skuId === sku.id)!
    expect(after.reservedQty).toBe(before.reservedQty)
    expect(after.availableQty).toBe(before.availableQty)
  })

  it("收款与履约按状态机推进，终态拒绝重复收款", async () => {
    const { db, service } = makeService()
    const sku = await firstSku(db)
    const order = await service.createOrder({ lines: [{ skuId: sku.id, quantity: 1 }] })

    await expect(service.payOrder(order.id)).rejects.toBeInstanceOf(DomainError)
    await service.confirmOrder(order.id)
    expect((await service.payOrder(order.id)).status).toBe("paid")
    expect((await service.fulfillOrder(order.id)).status).toBe("fulfilled")
    await expect(service.payOrder(order.id)).rejects.toBeInstanceOf(DomainError)
  })

  it("取消释放占用库存回可用量，总量不变；已收款不可取消", async () => {
    const { db, service } = makeService()
    const sku = await firstSku(db)
    const before = (await db.listLots()).find((lot) => lot.skuId === sku.id)!

    const order = await service.createOrder({ lines: [{ skuId: sku.id, quantity: 2 }] })
    expect((await service.cancelOrder(order.id)).status).toBe("cancelled")
    const afterCancel = (await db.listLots()).find((lot) => lot.skuId === sku.id)!
    expect(afterCancel.reservedQty).toBe(before.reservedQty)
    expect(afterCancel.availableQty).toBe(before.availableQty)
    expect(afterCancel.totalQty).toBe(before.totalQty)

    const paid = await service.createOrder({ lines: [{ skuId: sku.id, quantity: 1 }] })
    await service.confirmOrder(paid.id)
    await service.payOrder(paid.id)
    await expect(service.cancelOrder(paid.id)).rejects.toBeInstanceOf(DomainError)
  })

  it("履约扣减占用库存与总量，可用量不变", async () => {
    const { db, service } = makeService()
    const sku = await firstSku(db)
    const before = (await db.listLots()).find((lot) => lot.skuId === sku.id)!

    const order = await service.createOrder({ lines: [{ skuId: sku.id, quantity: 2 }] })
    await service.confirmOrder(order.id)
    await service.payOrder(order.id)
    expect((await service.fulfillOrder(order.id)).status).toBe("fulfilled")
    const after = (await db.listLots()).find((lot) => lot.skuId === sku.id)!
    expect(after.reservedQty).toBe(before.reservedQty)
    expect(after.availableQty).toBe(before.availableQty - 2)
    expect(after.totalQty).toBe(before.totalQty - 2)
  })
})
