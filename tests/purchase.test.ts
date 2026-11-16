import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { PurchaseService } from "../src/application/purchase.service"
import { InMemoryDatabase } from "../src/infrastructure/in-memory.database"

function makeService() {
  const db = new InMemoryDatabase()
  return { db, purchase: new PurchaseService(db) }
}

async function firstSku(db: InMemoryDatabase) {
  const sku = (await db.listSkus({ page: 1, pageSize: 20 })).items[0]
  if (!sku) throw new Error("演示数据缺少 SKU")
  return sku
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

async function draftOrder(db: InMemoryDatabase, purchase: PurchaseService, skuId: string, quantity: number) {
  const supplier = await makeSupplier(db, "测试供货商")
  return purchase.createPurchaseOrder({ supplierId: supplier.id, lines: [{ skuId, quantity }] })
}

describe("PurchaseService 采购深化", () => {
  it("建单初始状态 draft、行 receivedQty 为 0、rejectReason 为 null", async () => {
    const { db, purchase } = makeService()
    const sku = await firstSku(db)
    const order = await draftOrder(db, purchase, sku.id, 5)
    expect(order.status).toBe("draft")
    expect(order.lines[0]?.receivedQty).toBe(0)
    expect(order.rejectReason).toBeNull()
  })

  it("审核流：draft → submitted → approved；submitted 不能直接入库", async () => {
    const { db, purchase } = makeService()
    const sku = await firstSku(db)
    const order = await draftOrder(db, purchase, sku.id, 5)
    await purchase.submitPurchaseOrder(order.id)
    await expect(purchase.receivePurchaseOrder(order.id)).rejects.toThrow(/不允许入库/)
    const approved = await purchase.approvePurchaseOrder(order.id)
    expect(approved.status).toBe("approved")
  })

  it("驳回：空原因 400、原因落库、终态不可再审", async () => {
    const { db, purchase } = makeService()
    const sku = await firstSku(db)
    const order = await draftOrder(db, purchase, sku.id, 5)
    await purchase.submitPurchaseOrder(order.id)
    await expect(purchase.rejectPurchaseOrder(order.id, "")).rejects.toThrow(/驳回原因不能为空/)
    await expect(purchase.rejectPurchaseOrder(order.id, "   ")).rejects.toThrow(/驳回原因不能为空/)
    const rejected = await purchase.rejectPurchaseOrder(order.id, "价格高于市场价")
    expect(rejected.status).toBe("rejected")
    expect(rejected.rejectReason).toBe("价格高于市场价")
    await expect(purchase.approvePurchaseOrder(order.id)).rejects.toThrow(/不允许迁移/)
  })

  it("部分入库：先收 2 件变 partially_received、再收 3 件变 received，两次各建一张入库单", async () => {
    const { db, purchase } = makeService()
    const sku = await firstSku(db)
    const order = await draftOrder(db, purchase, sku.id, 5)
    await purchase.submitPurchaseOrder(order.id)
    await purchase.approvePurchaseOrder(order.id)

    const lotBefore = await db.findLotBySku(sku.id)
    const first = await purchase.receivePurchaseOrder(order.id, { lines: [{ skuId: sku.id, quantity: 2 }] })
    expect(first.order.status).toBe("partially_received")
    expect(first.order.lines[0]?.receivedQty).toBe(2)
    expect(first.receipt.receiptNo.startsWith("GRN-")).toBe(true)
    expect(first.receipt.lines).toHaveLength(1)
    expect(first.receipt.lines[0]?.quantity).toBe(2)
    expect(first.receipt.lines[0]?.batchCode).toBe("BATCH-001")
    expect(first.receipt.purchaseOrderId).toBe(order.id)
    const lotMid = await db.findLotBySku(sku.id)
    expect(lotMid?.availableQty).toBe((lotBefore?.availableQty ?? 0) + 2)

    const second = await purchase.receivePurchaseOrder(order.id, { lines: [{ skuId: sku.id, quantity: 3 }] })
    expect(second.order.status).toBe("received")
    expect(second.order.lines[0]?.receivedQty).toBe(5)
    expect(second.receipt.receiptNo).not.toBe(first.receipt.receiptNo)
    expect(second.receipt.lines[0]?.quantity).toBe(3)
    const lotAfter = await db.findLotBySku(sku.id)
    expect(lotAfter?.availableQty).toBe((lotBefore?.availableQty ?? 0) + 5)

    const receipts = await purchase.listReceipts({ page: 1, pageSize: 20 }, order.id)
    expect(receipts.total).toBe(2)
  })

  it("部分入库校验：超剩余量 409、行不在单内 400、收满后再次入库 409", async () => {
    const { db, purchase } = makeService()
    const sku = await firstSku(db)
    const order = await draftOrder(db, purchase, sku.id, 5)
    await purchase.submitPurchaseOrder(order.id)
    await purchase.approvePurchaseOrder(order.id)

    await expect(purchase.receivePurchaseOrder(order.id, { lines: [{ skuId: sku.id, quantity: 6 }] })).rejects.toThrow(/超过剩余/)
    await expect(
      purchase.receivePurchaseOrder(order.id, { lines: [{ skuId: randomUUID(), quantity: 1 }] }),
    ).rejects.toThrow(/没有该 SKU/)
    // 同一 SKU 在 body 里出现两次、累计超量也要拦
    await expect(
      purchase.receivePurchaseOrder(order.id, { lines: [{ skuId: sku.id, quantity: 3 }, { skuId: sku.id, quantity: 3 }] }),
    ).rejects.toThrow(/超过剩余/)

    await purchase.receivePurchaseOrder(order.id)
    const done = await db.findPurchaseOrder(order.id)
    expect(done?.status).toBe("received")
    await expect(purchase.receivePurchaseOrder(order.id)).rejects.toThrow(/不允许入库/)
  })

  it("整单入库（不传 lines）兼容老行为：一次收满、建一张入库单", async () => {
    const { db, purchase } = makeService()
    const sku = await firstSku(db)
    const order = await draftOrder(db, purchase, sku.id, 2)
    await purchase.submitPurchaseOrder(order.id)
    await purchase.approvePurchaseOrder(order.id)
    const result = await purchase.receivePurchaseOrder(order.id)
    expect(result.order.status).toBe("received")
    expect(result.receipt.lines[0]?.quantity).toBe(2)
  })
})
