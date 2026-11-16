import { describe, expect, it } from "vitest"
import { CustomerService } from "../src/application/customer.service"
import { SalesService } from "../src/application/sales.service"
import { DomainError } from "../src/domain/ports"
import { InMemoryDatabase } from "../src/infrastructure/in-memory.database"
import { MockPaymentGateway } from "../src/infrastructure/mock-payment.gateway"

function makeServices() {
  const db = new InMemoryDatabase()
  return {
    db,
    sales: new SalesService(db, new MockPaymentGateway()),
    customers: new CustomerService(db),
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

describe("CustomerService", () => {
  it("建客户成功，累计消费初始为 0，等級默认普通", async () => {
    const { customers } = makeServices()
    const created = await customers.createCustomer({ code: "CUST-001", name: "华东贸易有限公司", phone: "0571-88889999", level: "vip" })

    expect(created.code).toBe("CUST-001")
    expect(created.level).toBe("vip")
    expect(created.enabled).toBe(true)
    expect(created.totalSpent).toEqual({ amount: 0, currency: "CNY" })

    const found = await customers.findCustomer(created.id)
    expect(found.totalSpent).toEqual({ amount: 0, currency: "CNY" })

    const defaulted = await customers.createCustomer({ code: "CUST-002", name: "李明" })
    expect(defaulted.level).toBe("regular")
    expect(defaulted.phone).toBeNull()
  })

  it("编码重复建客户报 409", async () => {
    const { customers } = makeServices()
    await customers.createCustomer({ code: "CUST-001", name: "甲" })
    await expect(
      customers.createCustomer({ code: "CUST-001", name: "乙" })
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
  })

  it("更新停用与启用，编码不可改，空改报 400", async () => {
    const { customers } = makeServices()
    const created = await customers.createCustomer({ code: "CUST-001", name: "甲" })

    const disabled = await customers.updateCustomer(created.id, { enabled: false })
    expect(disabled.enabled).toBe(false)
    expect(disabled.code).toBe("CUST-001")

    const renamed = await customers.updateCustomer(created.id, { name: "甲公司", enabled: true, level: "vip" })
    expect(renamed.name).toBe("甲公司")
    expect(renamed.enabled).toBe(true)
    expect(renamed.level).toBe("vip")

    await expect(customers.updateCustomer(created.id, {})).rejects.toMatchObject({ code: "INVALID_STATE" })
    await expect(customers.updateCustomer("00000000-0000-4000-8000-000000000999", { name: "无" })).rejects.toBeInstanceOf(DomainError)
  })

  it("查不到的客户报 404", async () => {
    const { customers } = makeServices()
    await expect(customers.findCustomer("00000000-0000-4000-8000-000000000999")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
  })

  it("全链路：建客户→建单关联→确认→收款→履约，累计消费跟单走；取消的单不计入", async () => {
    const { db, sales, customers } = makeServices()
    const a = await firstSku(db)
    const b = await secondSku(db)

    const customer = await customers.createCustomer({ code: "CUST-001", name: "华东贸易有限公司", level: "vip" })
    const other = await customers.createCustomer({ code: "CUST-002", name: "李明" })

    // 建单即关联：draft 也计入（只有 cancelled 不计）
    const order = await sales.createOrder({ customerId: customer.id, lines: [{ skuId: a.id, quantity: 2 }] })
    expect(order.customerId).toBe(customer.id)
    expect(order.total.amount).toBe(39800)
    expect((await customers.findCustomer(customer.id)).totalSpent.amount).toBe(39800)

    await sales.confirmOrder(order.id)
    expect((await customers.findCustomer(customer.id)).totalSpent.amount).toBe(39800)
    await sales.payOrder(order.id)
    expect((await customers.findCustomer(customer.id)).totalSpent.amount).toBe(39800)
    await sales.fulfillOrder(order.id)
    expect((await customers.findCustomer(customer.id)).totalSpent.amount).toBe(39800)

    // 取消的单不计入；别人的单也不计入
    const cancelled = await sales.createOrder({ customerId: customer.id, lines: [{ skuId: b.id, quantity: 1 }] })
    await sales.cancelOrder(cancelled.id)
    const strangers = await sales.createOrder({ customerId: other.id, lines: [{ skuId: a.id, quantity: 1 }] })
    expect((await customers.findCustomer(customer.id)).totalSpent.amount).toBe(39800)
    expect((await customers.findCustomer(other.id)).totalSpent.amount).toBe(19900)
    expect(strangers.customerId).toBe(other.id)

    // 列表页的累计消费与单查一致
    const page = await customers.listCustomers({ page: 1, pageSize: 20 })
    expect(page.total).toBe(2)
    const byId = new Map(page.items.map((c) => [c.id, c]))
    expect(byId.get(customer.id)?.totalSpent.amount).toBe(39800)
    expect(byId.get(other.id)?.totalSpent.amount).toBe(19900)
  })

  it("建单传不存在的客户报 404，且不占库存", async () => {
    const { db, sales } = makeServices()
    const sku = await firstSku(db)
    const before = (await db.listLots({ page: 1, pageSize: 20 })).items.find((lot) => lot.skuId === sku.id)!

    await expect(
      sales.createOrder({ customerId: "00000000-0000-4000-8000-000000000999", lines: [{ skuId: sku.id, quantity: 1 }] })
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })

    const after = (await db.listLots({ page: 1, pageSize: 20 })).items.find((lot) => lot.skuId === sku.id)!
    expect(after.reservedQty).toBe(before.reservedQty)
    expect(after.availableQty).toBe(before.availableQty)
  })
})
