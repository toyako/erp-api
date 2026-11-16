import { describe, expect, it } from "vitest"
import { ProductService } from "../src/application/product.service"
import { DomainError } from "../src/domain/ports"
import { InMemoryDatabase } from "../src/infrastructure/in-memory.database"

function makeServices() {
  const db = new InMemoryDatabase()
  return { db, product: new ProductService(db) }
}

async function firstSpu(db: InMemoryDatabase) {
  const spu = (await db.listSpus({ page: 1, pageSize: 20 })).items[0]
  if (!spu) throw new Error("演示数据缺少 SPU")
  return spu
}

async function firstSku(db: InMemoryDatabase) {
  const sku = (await db.listSkus({ page: 1, pageSize: 20 })).items[0]
  if (!sku) throw new Error("演示数据缺少 SKU")
  return sku
}

describe("ProductService", () => {
  it("新建 SKU 成功，编码查重 409，SPU 不存在 404", async () => {
    const { db, product } = makeServices()
    const spu = await firstSpu(db)

    const created = await product.createSku({ spuId: spu.id, code: "SKU-003", spec: "旗舰版", unit: "套" })
    expect(created.code).toBe("SKU-003")
    expect(created.spuId).toBe(spu.id)
    expect(created.enabled).toBe(true)

    await expect(
      product.createSku({ spuId: spu.id, code: "SKU-003", spec: "重复", unit: "套" })
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
    await expect(
      product.createSku({ spuId: "00000000-0000-4000-8000-000000000999", code: "SKU-004", spec: "无", unit: "套" })
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })

    const page = await db.listSkus({ page: 1, pageSize: 20 })
    expect(page.total).toBe(3)
  })

  it("SPU 列表只有种子里的一个", async () => {
    const { product } = makeServices()
    const page = await product.listSpus({ page: 1, pageSize: 20 })
    expect(page.total).toBe(1)
    expect(page.items[0]).toMatchObject({ name: "云智物标准套件", categoryCode: "SOFTWARE" })
  })

  it("价格列表按 SKU 升序；新建价格后定价取生效最晚的一条", async () => {
    const { db, product } = makeServices()
    const sku = await firstSku(db)

    const before = await db.findPriceBySku(sku.id)
    expect(before?.price.amount).toBe(19900)

    const created = await product.createPrice({
      skuId: sku.id,
      channelCode: "default",
      price: { amount: 24900, currency: "CNY" },
      effectiveFrom: "2026-11-16T00:00:00.000Z",
    })
    expect(created.price.amount).toBe(24900)

    const after = await db.findPriceBySku(sku.id)
    expect(after?.price.amount).toBe(24900)

    const page = await product.listPrices({ page: 1, pageSize: 20 })
    expect(page.total).toBe(3)
    expect(page.items[0]?.skuId).toBe(sku.id)
  })

  it("改价只改金额与截止时间；改价后旧价格不再是定价依据", async () => {
    const { db, product } = makeServices()
    const sku = await firstSku(db)
    const current = await db.findPriceBySku(sku.id)
    if (!current) throw new Error("演示数据缺少价格")

    const updated = await product.updatePrice(current.id, { price: { amount: 21900, currency: "CNY" } })
    expect(updated.price.amount).toBe(21900)
    expect((await db.findPriceBySku(sku.id))?.price.amount).toBe(21900)

    const closed = await product.updatePrice(current.id, { effectiveTo: "2026-11-16T00:00:00.000Z" })
    expect(closed.effectiveTo).toBe("2026-11-16T00:00:00.000Z")
    expect(await db.findPriceBySku(sku.id)).toBeNull()

    await expect(product.updatePrice(current.id, {})).rejects.toMatchObject({ code: "INVALID_STATE", status: 400 })
    await expect(
      product.updatePrice("00000000-0000-4000-8000-000000000999", { price: { amount: 100, currency: "CNY" } })
    ).rejects.toBeInstanceOf(DomainError)
  })

  it("给不存在的 SKU 建价格报 404", async () => {
    const { product } = makeServices()
    await expect(
      product.createPrice({ skuId: "00000000-0000-4000-8000-000000000999", price: { amount: 100, currency: "CNY" } })
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
  })

  it("SKU-002 价格与 Prisma 种子一致为 ¥299", async () => {
    const { db } = makeServices()
    const skus = (await db.listSkus({ page: 1, pageSize: 20 })).items
    const skuB = skus.find((s) => s.code === "SKU-002")
    if (!skuB) throw new Error("演示数据缺少 SKU-002")
    expect((await db.findPriceBySku(skuB.id))?.price.amount).toBe(29900)
  })
})
