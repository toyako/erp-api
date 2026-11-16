import { describe, expect, it } from "vitest"
import { SalesService } from "../src/application/sales.service"
import { ShipmentService } from "../src/application/shipment.service"
import { InMemoryDatabase } from "../src/infrastructure/in-memory.database"
import { MockPaymentGateway } from "../src/infrastructure/mock-payment.gateway"

function makeServices() {
  const db = new InMemoryDatabase()
  return {
    db,
    sales: new SalesService(db, new MockPaymentGateway()),
    shipment: new ShipmentService(db),
  }
}

async function firstSku(db: InMemoryDatabase) {
  const sku = (await db.listSkus({ page: 1, pageSize: 20 })).items[0]
  if (!sku) throw new Error("演示数据缺少 SKU")
  return sku
}

/** 建单→确认→收款，走完一单已付款订单（未履约） */
async function paidOrder(db: InMemoryDatabase, sales: SalesService, skuId: string, quantity: number) {
  const order = await sales.createOrder({ lines: [{ skuId, quantity }] })
  await sales.confirmOrder(order.id)
  await sales.payOrder(order.id)
  return order
}

/** 建单→确认→收款→履约，走完一单已发货订单 */
async function fulfilledOrder(db: InMemoryDatabase, sales: SalesService, skuId: string, quantity: number) {
  const order = await paidOrder(db, sales, skuId, quantity)
  await sales.fulfillOrder(order.id)
  return order
}

async function lotOf(db: InMemoryDatabase, skuId: string) {
  const lot = await db.findLotBySku(skuId)
  if (!lot) throw new Error("演示数据缺少批次")
  return lot
}

describe("ShipmentService", () => {
  it("建单成功：行照抄订单行、状态 draft、单号 SHP- 开头、承运商与单号为空", async () => {
    const { db, sales, shipment } = makeServices()
    const sku = await firstSku(db)
    const order = await paidOrder(db, sales, sku.id, 2)

    const created = await shipment.createShipment({ orderId: order.id })
    expect(created.status).toBe("draft")
    expect(created.shipmentNo.startsWith("SHP-")).toBe(true)
    expect(created.orderNo).toBe(order.orderNo)
    expect(created.lines).toEqual([{ skuId: sku.id, quantity: 2, batchCode: null }])
    expect(created.carrier).toBeNull()
    expect(created.trackingNo).toBeNull()
    expect(created.shippedAt).toBeNull()
    expect(created.deliveredAt).toBeNull()
  })

  it("建单校验：订单不存在 404；草稿/已确认/已发货订单建单都报 409；同一订单重复建单报 409", async () => {
    const { db, sales, shipment } = makeServices()
    const sku = await firstSku(db)

    await expect(shipment.createShipment({ orderId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })

    const draft = await sales.createOrder({ lines: [{ skuId: sku.id, quantity: 1 }] })
    await expect(shipment.createShipment({ orderId: draft.id })).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })
    await sales.confirmOrder(draft.id)
    await expect(shipment.createShipment({ orderId: draft.id })).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })

    const fulfilled = await fulfilledOrder(db, sales, sku.id, 1)
    await expect(shipment.createShipment({ orderId: fulfilled.id })).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })

    const paid = await paidOrder(db, sales, sku.id, 1)
    await shipment.createShipment({ orderId: paid.id })
    await expect(shipment.createShipment({ orderId: paid.id })).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
  })

  it("状态机全走通：拣货回填 batchCode、发货落承运商与单号、送达落时间", async () => {
    const { db, sales, shipment } = makeServices()
    const sku = await firstSku(db)
    const order = await paidOrder(db, sales, sku.id, 1)
    const created = await shipment.createShipment({ orderId: order.id })

    const picked = await shipment.pickShipment(created.id)
    expect(picked.status).toBe("picking")
    expect(picked.lines[0]?.batchCode).toBe("BATCH-001")

    const packed = await shipment.packShipment(created.id)
    expect(packed.status).toBe("packed")

    const shipped = await shipment.shipShipment(created.id, { carrier: "顺丰速运", trackingNo: "SF1234567890" })
    expect(shipped.status).toBe("shipped")
    expect(shipped.carrier).toBe("顺丰速运")
    expect(shipped.trackingNo).toBe("SF1234567890")
    expect(shipped.shippedAt).not.toBeNull()

    const delivered = await shipment.deliverShipment(created.id)
    expect(delivered.status).toBe("delivered")
    expect(delivered.deliveredAt).not.toBeNull()
  })

  it("非法流转报 409：draft 直接发货/送达、已送达再送达、已发货取消", async () => {
    const { db, sales, shipment } = makeServices()
    const sku = await firstSku(db)
    const order = await paidOrder(db, sales, sku.id, 1)
    const created = await shipment.createShipment({ orderId: order.id })

    await expect(
      shipment.shipShipment(created.id, { carrier: "顺丰速运", trackingNo: "SF1" }),
    ).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })
    await expect(shipment.deliverShipment(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })

    await shipment.pickShipment(created.id)
    await shipment.packShipment(created.id)
    await shipment.shipShipment(created.id, { carrier: "顺丰速运", trackingNo: "SF1" })
    await expect(shipment.cancelShipment(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })
    await shipment.deliverShipment(created.id)
    await expect(shipment.deliverShipment(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })
  })

  it("发货联动履约：订单变 fulfilled、占用扣掉、总量减少、可用量不变", async () => {
    const { db, sales, shipment } = makeServices()
    const sku = await firstSku(db)
    const order = await paidOrder(db, sales, sku.id, 2)
    const before = await lotOf(db, sku.id)
    expect(before.reservedQty).toBe(2)

    const created = await shipment.createShipment({ orderId: order.id })
    await shipment.pickShipment(created.id)
    await shipment.packShipment(created.id)
    await shipment.shipShipment(created.id, { carrier: "顺丰速运", trackingNo: "SF1" })

    const afterOrder = await db.findOrder(order.id)
    expect(afterOrder?.status).toBe("fulfilled")
    const after = await lotOf(db, sku.id)
    expect(after.reservedQty).toBe(0)
    expect(after.totalQty).toBe(before.totalQty - 2)
    expect(after.availableQty).toBe(before.availableQty)
  })

  it("订单已走独立履约口时再发货不重复扣库存", async () => {
    const { db, sales, shipment } = makeServices()
    const sku = await firstSku(db)
    const order = await paidOrder(db, sales, sku.id, 2)
    const created = await shipment.createShipment({ orderId: order.id })
    await shipment.pickShipment(created.id)
    await shipment.packShipment(created.id)

    await sales.fulfillOrder(order.id)
    const afterFulfill = await lotOf(db, sku.id)
    expect(afterFulfill.totalQty).toBe(98)

    const shipped = await shipment.shipShipment(created.id, { carrier: "顺丰速运", trackingNo: "SF1" })
    expect(shipped.status).toBe("shipped")
    const afterShip = await lotOf(db, sku.id)
    expect(afterShip.totalQty).toBe(98)
    expect(afterShip.reservedQty).toBe(0)
  })

  it("取消只取消发货单：draft/picking/packed 可取消，取消后订单仍为 paid、可重建发货单", async () => {
    const { db, sales, shipment } = makeServices()
    const sku = await firstSku(db)
    const order = await paidOrder(db, sales, sku.id, 1)
    const created = await shipment.createShipment({ orderId: order.id })

    const cancelled = await shipment.cancelShipment(created.id)
    expect(cancelled.status).toBe("cancelled")
    const afterOrder = await db.findOrder(order.id)
    expect(afterOrder?.status).toBe("paid")

    const recreated = await shipment.createShipment({ orderId: order.id })
    expect(recreated.status).toBe("draft")
    expect(recreated.shipmentNo).not.toBe(created.shipmentNo)
  })
})
