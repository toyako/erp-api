import { describe, expect, it } from "vitest"
import { TransferService } from "../src/application/transfer.service"
import { DomainError } from "../src/domain/ports"
import { InMemoryDatabase } from "../src/infrastructure/in-memory.database"

function makeServices() {
  const db = new InMemoryDatabase()
  return { db, transfer: new TransferService(db) }
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

async function lotsOf(db: InMemoryDatabase, skuId: string) {
  return (await db.listLots({ page: 1, pageSize: 20 })).items.filter((l) => l.skuId === skuId)
}

describe("TransferService", () => {
  it("建单成功，状态草稿，单号 TRF- 开头，batchCode 为空，建单不扣库存", async () => {
    const { db, transfer } = makeServices()
    const sku = await firstSku(db)
    const before = await lotsOf(db, sku.id)

    const created = await transfer.createTransfer({ skuId: sku.id, fromLocation: "主仓", toLocation: "华东仓", quantity: 5 })
    expect(created.status).toBe("draft")
    expect(created.transferNo.startsWith("TRF-")).toBe(true)
    expect(created.batchCode).toBeNull()
    expect(created.completedAt).toBeNull()

    const after = await lotsOf(db, sku.id)
    expect(after).toEqual(before)
    const found = await transfer.findTransfer(created.id)
    expect(found.transferNo).toBe(created.transferNo)
  })

  it("同库位建单报 400，SKU 不存在报 404", async () => {
    const { db, transfer } = makeServices()
    const sku = await firstSku(db)
    await expect(
      transfer.createTransfer({ skuId: sku.id, fromLocation: "主仓", toLocation: "主仓", quantity: 1 })
    ).rejects.toMatchObject({ code: "INVALID_STATE", status: 400 })
    await expect(
      transfer.createTransfer({ skuId: "00000000-0000-4000-8000-000000000999", fromLocation: "主仓", toLocation: "华东仓", quantity: 1 })
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
  })

  it("完成调拨：源批次扣数、目标新建同 batchCode 批次、回填 batchCode 并记完成时间", async () => {
    const { db, transfer } = makeServices()
    const sku = await firstSku(db)
    // 种子：BATCH-001 在主仓 100/0/100，华东仓无该 SKU 批次
    expect((await lotsOf(db, sku.id)).some((l) => l.location === "华东仓")).toBe(false)

    const created = await transfer.createTransfer({ skuId: sku.id, fromLocation: "主仓", toLocation: "华东仓", quantity: 5 })
    const done = await transfer.completeTransfer(created.id)
    expect(done.status).toBe("completed")
    expect(done.batchCode).toBe("BATCH-001")
    expect(done.completedAt).not.toBeNull()

    const lots = await lotsOf(db, sku.id)
    const source = lots.find((l) => l.location === "主仓")!
    expect(source.availableQty).toBe(95)
    expect(source.totalQty).toBe(95)
    expect(source.reservedQty).toBe(0)
    const dest = lots.find((l) => l.location === "华东仓")!
    expect(dest.batchCode).toBe("BATCH-001")
    expect(dest.availableQty).toBe(5)
    expect(dest.totalQty).toBe(5)
    expect(dest.reservedQty).toBe(0)

    // 终态不可再动
    await expect(transfer.completeTransfer(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })
    await expect(transfer.cancelTransfer(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })
  })

  it("目标已有同批次时直接加数，不新建批次", async () => {
    const { db, transfer } = makeServices()
    const sku = await firstSku(db)
    const first = await transfer.createTransfer({ skuId: sku.id, fromLocation: "主仓", toLocation: "华东仓", quantity: 5 })
    await transfer.completeTransfer(first.id)
    const second = await transfer.createTransfer({ skuId: sku.id, fromLocation: "主仓", toLocation: "华东仓", quantity: 3 })
    await transfer.completeTransfer(second.id)

    const lots = await lotsOf(db, sku.id)
    expect(lots).toHaveLength(2)
    expect(lots.find((l) => l.location === "主仓")!.availableQty).toBe(92)
    expect(lots.find((l) => l.location === "华东仓")!.availableQty).toBe(8)
  })

  it("源库位无该 SKU 批次报 409，可用不足报 409", async () => {
    const { db, transfer } = makeServices()
    const a = await firstSku(db)
    const b = await secondSku(db)
    // SKU-002 的批次只在华东仓，主仓没有
    const noSource = await transfer.createTransfer({ skuId: b.id, fromLocation: "主仓", toLocation: "华东仓", quantity: 1 })
    await expect(transfer.completeTransfer(noSource.id)).rejects.toMatchObject({ code: "CONFLICT", status: 409 })

    // SKU-001 主仓可用 100，调 101 不足
    const over = await transfer.createTransfer({ skuId: a.id, fromLocation: "主仓", toLocation: "华东仓", quantity: 101 })
    await expect(transfer.completeTransfer(over.id)).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
    // 失败后仍是草稿、库存未动
    expect((await transfer.findTransfer(over.id)).status).toBe("draft")
    expect((await lotsOf(db, a.id)).find((l) => l.location === "主仓")!.availableQty).toBe(100)
  })

  it("取消不动库存；查不到的调拨单报 404；列表分页与倒序", async () => {
    const { db, transfer } = makeServices()
    const sku = await firstSku(db)
    const created = await transfer.createTransfer({ skuId: sku.id, fromLocation: "主仓", toLocation: "华东仓", quantity: 5 })
    const cancelled = await transfer.cancelTransfer(created.id)
    expect(cancelled.status).toBe("cancelled")
    expect((await lotsOf(db, sku.id)).find((l) => l.location === "主仓")!.availableQty).toBe(100)
    await expect(transfer.completeTransfer(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })

    await expect(transfer.findTransfer("00000000-0000-4000-8000-000000000999")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
    await expect(transfer.completeTransfer("00000000-0000-4000-8000-000000000999")).rejects.toBeInstanceOf(DomainError)

    const a = await transfer.createTransfer({ skuId: sku.id, fromLocation: "主仓", toLocation: "华东仓", quantity: 1 })
    const b = await transfer.createTransfer({ skuId: sku.id, fromLocation: "主仓", toLocation: "华东仓", quantity: 2 })
    const page = await transfer.listTransfers({ page: 1, pageSize: 1 })
    expect(page.total).toBe(4)
    expect(page.items).toHaveLength(1)
    expect([a.id, b.id]).toContain(page.items[0]!.id)
    const all = await transfer.listTransfers({ page: 1, pageSize: 20 })
    expect(all.items.map((x) => x.id)).toContain(a.id)
    expect(all.items.map((x) => x.id)).toContain(b.id)
    // 演示种子 TRF-DEMO-001 的创建时间是当天 00:00，最旧，排在最后
    expect(all.items[all.items.length - 1]!.transferNo).toBe("TRF-DEMO-001")
  })
})
