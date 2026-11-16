import { describe, expect, it } from "vitest"
import { nextDocNo } from "../src/domain/doc-no"
import { SalesService } from "../src/application/sales.service"
import { InMemoryDatabase } from "../src/infrastructure/in-memory.database"
import { MockPaymentGateway } from "../src/infrastructure/mock-payment.gateway"

describe("nextDocNo", () => {
  it("同一毫秒连调 20 次单号全不重（同步紧循环是最坏情况）", () => {
    const nos = Array.from({ length: 20 }, () => nextDocNo("PO"))
    expect(new Set(nos).size).toBe(20)
  })

  it("格式为 前缀-时间戳(base36 大写)+2 位随机 base36 后缀", () => {
    const no = nextDocNo("ERP")
    expect(no).toMatch(/^ERP-[0-9A-Z]+[0-9A-Z]{2}$/)
    expect(no.startsWith("ERP-")).toBe(true)
    // 同一前缀连续调用也不重
    expect(nextDocNo("ERP")).not.toBe(no)
  })

  it("服务层连建 20 单单号全不重", async () => {
    const db = new InMemoryDatabase()
    const sales = new SalesService(db, new MockPaymentGateway())
    const sku = (await db.listSkus({ page: 1, pageSize: 20 })).items[0]!
    const nos: string[] = []
    for (let i = 0; i < 20; i++) {
      const order = await sales.createOrder({ lines: [{ skuId: sku.id, quantity: 1 }] })
      nos.push(order.orderNo)
    }
    expect(new Set(nos).size).toBe(20)
  })
})
