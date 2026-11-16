import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { InvoiceService } from "../src/application/invoice.service"
import { SalesService } from "../src/application/sales.service"
import { InMemoryDatabase } from "../src/infrastructure/in-memory.database"
import { MockPaymentGateway } from "../src/infrastructure/mock-payment.gateway"

function makeServices() {
  const db = new InMemoryDatabase()
  return {
    db,
    sales: new SalesService(db, new MockPaymentGateway()),
    invoice: new InvoiceService(db),
  }
}

async function firstSku(db: InMemoryDatabase) {
  const sku = (await db.listSkus({ page: 1, pageSize: 20 })).items[0]
  if (!sku) throw new Error("演示数据缺少 SKU")
  return sku
}

/** 建单→确认→收款，走完一单已付款订单（未履约） */
async function paidOrder(db: InMemoryDatabase, sales: SalesService, skuId: string, quantity: number, customerId?: string) {
  const order = await sales.createOrder({ lines: [{ skuId, quantity }], ...(customerId ? { customerId } : {}) })
  await sales.confirmOrder(order.id)
  await sales.payOrder(order.id)
  return order
}

async function makeCustomer(db: InMemoryDatabase, name: string) {
  const customer = {
    id: randomUUID(),
    tenantId: "00000000-0000-4000-8000-000000000001",
    code: `CUST-${name}`,
    name,
    phone: null,
    level: "regular" as const,
    enabled: true,
    totalSpent: { amount: 0, currency: "CNY" },
    createdAt: new Date().toISOString(),
  }
  await db.saveCustomer(customer)
  return customer
}

describe("InvoiceService", () => {
  it("建单成功：类型默认普票、抬头默认散客、单号 INV- 开头、状态 draft", async () => {
    const { db, sales, invoice } = makeServices()
    const sku = await firstSku(db)
    const order = await paidOrder(db, sales, sku.id, 1)

    const created = await invoice.createInvoice({ orderId: order.id, amount: { amount: 19900, currency: "CNY" } })
    expect(created.status).toBe("draft")
    expect(created.invoiceNo.startsWith("INV-")).toBe(true)
    expect(created.orderNo).toBe(order.orderNo)
    expect(created.customerId).toBeNull()
    expect(created.amount).toEqual({ amount: 19900, currency: "CNY" })
    expect(created.type).toBe("vat_normal")
    expect(created.title).toBe("散客")
    expect(created.issuedAt).toBeNull()
  })

  it("抬头默认订单客户名；建单时可指定类型与抬头", async () => {
    const { db, sales, invoice } = makeServices()
    const sku = await firstSku(db)
    const customer = await makeCustomer(db, "华东贸易有限公司")
    const order = await paidOrder(db, sales, sku.id, 1, customer.id)

    const created = await invoice.createInvoice({
      orderId: order.id,
      amount: { amount: 19900, currency: "CNY" },
      type: "vat_special",
      title: "华东贸易有限公司（专票）",
    })
    expect(created.title).toBe("华东贸易有限公司（专票）")
    expect(created.type).toBe("vat_special")
    expect(created.customerId).toBe(customer.id)

    const order2 = await paidOrder(db, sales, sku.id, 1, customer.id)
    const created2 = await invoice.createInvoice({ orderId: order2.id, amount: { amount: 19900, currency: "CNY" } })
    expect(created2.title).toBe("华东贸易有限公司")
  })

  it("建单校验：订单不存在 404；草稿/已确认订单 409；币种不一致 400；金额超剩余可开额度 409", async () => {
    const { db, sales, invoice } = makeServices()
    const sku = await firstSku(db)

    await expect(
      invoice.createInvoice({ orderId: "00000000-0000-4000-8000-000000000000", amount: { amount: 100, currency: "CNY" } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })

    const draft = await sales.createOrder({ lines: [{ skuId: sku.id, quantity: 1 }] })
    await expect(
      invoice.createInvoice({ orderId: draft.id, amount: { amount: 100, currency: "CNY" } }),
    ).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })
    await sales.confirmOrder(draft.id)
    await expect(
      invoice.createInvoice({ orderId: draft.id, amount: { amount: 100, currency: "CNY" } }),
    ).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })

    const paid = await paidOrder(db, sales, sku.id, 1)
    await expect(
      invoice.createInvoice({ orderId: paid.id, amount: { amount: 100, currency: "USD" } }),
    ).rejects.toMatchObject({ code: "INVALID_STATE", status: 400 })
    await expect(
      invoice.createInvoice({ orderId: paid.id, amount: { amount: 19901, currency: "CNY" } }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
  })

  it("一单可多张：累计不超过订单总额；作废/取消释放额度", async () => {
    const { db, sales, invoice } = makeServices()
    const sku = await firstSku(db)
    const order = await paidOrder(db, sales, sku.id, 2)

    const first = await invoice.createInvoice({ orderId: order.id, amount: { amount: 19900, currency: "CNY" } })
    const second = await invoice.createInvoice({ orderId: order.id, amount: { amount: 19900, currency: "CNY" } })
    expect(second.status).toBe("draft")
    await expect(
      invoice.createInvoice({ orderId: order.id, amount: { amount: 1, currency: "CNY" } }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })

    // 作废只针对已开票的单：先开票再作废，额度释放
    await invoice.issueInvoice(first.id)
    await invoice.voidInvoice(first.id)
    const third = await invoice.createInvoice({ orderId: order.id, amount: { amount: 19900, currency: "CNY" } })
    expect(third.status).toBe("draft")
    await expect(
      invoice.createInvoice({ orderId: order.id, amount: { amount: 1, currency: "CNY" } }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })

    await invoice.cancelInvoice(second.id)
    const fourth = await invoice.createInvoice({ orderId: order.id, amount: { amount: 19900, currency: "CNY" } })
    expect(fourth.status).toBe("draft")
  })

  it("状态机：draft→issued 记 issuedAt；issued→voided；draft→cancelled；非法流转 409", async () => {
    const { db, sales, invoice } = makeServices()
    const sku = await firstSku(db)
    const order = await paidOrder(db, sales, sku.id, 1)
    const created = await invoice.createInvoice({ orderId: order.id, amount: { amount: 19900, currency: "CNY" } })

    await expect(invoice.voidInvoice(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })

    const issued = await invoice.issueInvoice(created.id)
    expect(issued.status).toBe("issued")
    expect(issued.issuedAt).not.toBeNull()
    await expect(invoice.cancelInvoice(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })
    await expect(invoice.issueInvoice(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })

    const voided = await invoice.voidInvoice(created.id)
    expect(voided.status).toBe("voided")
    await expect(invoice.issueInvoice(created.id)).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 })

    const order2 = await paidOrder(db, sales, sku.id, 1)
    const created2 = await invoice.createInvoice({ orderId: order2.id, amount: { amount: 19900, currency: "CNY" } })
    const cancelled = await invoice.cancelInvoice(created2.id)
    expect(cancelled.status).toBe("cancelled")
  })
})
