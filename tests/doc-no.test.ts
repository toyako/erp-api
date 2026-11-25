import { beforeEach, describe, expect, it } from "vitest"
import { nextDocNo, resetDocNoState } from "../src/domain/doc-no"
import { todayInTimezone } from "../src/domain/timezone"
import { SalesService } from "../src/application/sales.service"
import { InMemoryDatabase } from "../src/infrastructure/in-memory.database"
import { MockPaymentGateway } from "../src/infrastructure/mock-payment.gateway"

const emptyPage = async () => ({ items: [] as string[], total: 0, page: 1, pageSize: 200 })

describe("nextDocNo", () => {
  beforeEach(() => resetDocNoState())

  it("格式为 前缀-日期(租户时区 YYYYMMDD)-当日 4 位序号", async () => {
    const date = todayInTimezone().replaceAll("-", "")
    const no = await nextDocNo("SO", emptyPage, (x: string) => x)
    expect(no).toMatch(new RegExp(`^SO-${date}-\\d{4}$`))
  })

  it("同一前缀连续取号严格递增，从 0001 开始", async () => {
    const date = todayInTimezone().replaceAll("-", "")
    const nos: string[] = []
    for (let i = 0; i < 20; i++) {
      nos.push(await nextDocNo("PO", emptyPage, (x: string) => x))
    }
    expect(new Set(nos).size).toBe(20)
    expect(nos).toEqual(Array.from({ length: 20 }, (_, i) => `PO-${date}-${String(i + 1).padStart(4, "0")}`))
  })

  it("并发首调用共用播种、单号全不重", async () => {
    const nos = await Promise.all(
      Array.from({ length: 20 }, () => nextDocNo("PO", emptyPage, (x: string) => x)),
    )
    expect(new Set(nos).size).toBe(20)
  })

  it("不同前缀序号互不干扰", async () => {
    const date = todayInTimezone().replaceAll("-", "")
    const so = await nextDocNo("SO", emptyPage, (x: string) => x)
    const po = await nextDocNo("PO", emptyPage, (x: string) => x)
    expect(so).toBe(`SO-${date}-0001`)
    expect(po).toBe(`PO-${date}-0001`)
  })

  it("服务层连建 20 单单号全不重且连续", async () => {
    const date = todayInTimezone().replaceAll("-", "")
    const db = new InMemoryDatabase()
    const sales = new SalesService(db, new MockPaymentGateway())
    const sku = (await db.listSkus({ page: 1, pageSize: 20 })).items[0]!
    const nos: string[] = []
    for (let i = 0; i < 20; i++) {
      const order = await sales.createOrder({ lines: [{ skuId: sku.id, quantity: 1 }] })
      nos.push(order.orderNo)
    }
    expect(new Set(nos).size).toBe(20)
    expect(nos).toEqual(Array.from({ length: 20 }, (_, i) => `SO-${date}-${String(i + 1).padStart(4, "0")}`))
  })

  it("进程重启后从库里最大序号续发、不从 0001 重发", async () => {
    const db = new InMemoryDatabase()
    const sales = new SalesService(db, new MockPaymentGateway())
    const sku = (await db.listSkus({ page: 1, pageSize: 20 })).items[0]!
    const first = await sales.createOrder({ lines: [{ skuId: sku.id, quantity: 1 }] })
    const second = await sales.createOrder({ lines: [{ skuId: sku.id, quantity: 1 }] })
    expect(second.orderNo).not.toBe(first.orderNo)
    // 模拟进程重启：清空进程内缓存
    resetDocNoState()
    const third = await sales.createOrder({ lines: [{ skuId: sku.id, quantity: 1 }] })
    const seq = (no: string) => Number(no.split("-")[2])
    expect(seq(third.orderNo)).toBe(seq(second.orderNo) + 1)
  })
})
