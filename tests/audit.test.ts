import { describe, expect, it } from "vitest"
import type { CallHandler, ExecutionContext } from "@nestjs/common"
import { lastValueFrom, of, throwError } from "rxjs"
import { AuditInterceptor } from "../src/interface/http/audit.interceptor"
import { InMemoryDatabase } from "../src/infrastructure/in-memory.database"

function makeInterceptor() {
  const db = new InMemoryDatabase()
  return { db, interceptor: new AuditInterceptor(db) }
}

function mockContext(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext
}

function mockHandler(result: unknown): CallHandler {
  return { handle: () => of(result) } as CallHandler
}

/** 拦截器写审计是 fire-and-forget，等一小会儿让异步写入落库 */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe("AuditInterceptor", () => {
  it("写请求成功记一条：动作/对象/单据号/操作人/摘要齐全", async () => {
    const { db, interceptor } = makeInterceptor()
    const req = {
      method: "POST",
      path: "/api/customers",
      headers: {},
      body: { code: "CUST-001", name: "华东贸易有限公司" },
    }
    await lastValueFrom(
      interceptor.intercept(
        mockContext(req),
        mockHandler({ id: "00000000-0000-4000-8000-000000000001" }),
      ),
    )
    await settle()

    const page = await db.listAuditEvents({ page: 1, pageSize: 20 })
    expect(page.total).toBe(1)
    const event = page.items[0]!
    expect(event.action).toBe("POST /customers")
    expect(event.targetType).toBe("customers")
    expect(event.targetId).toBe("00000000-0000-4000-8000-000000000001")
    expect(event.actorId).toBe("admin")
    expect(event.payload?.detail).toContain("CUST-001")
  })

  it("GET 不记；失败的写请求不记；登录请求不记", async () => {
    const { db, interceptor } = makeInterceptor()

    await lastValueFrom(
      interceptor.intercept(
        mockContext({ method: "GET", path: "/api/customers", headers: {}, body: {} }),
        mockHandler({ items: [], total: 0 }),
      ),
    )
    await expect(
      lastValueFrom(
        interceptor.intercept(
          mockContext({ method: "POST", path: "/api/customers", headers: {}, body: { code: "X" } }),
          { handle: () => throwError(() => new Error("boom")) } as CallHandler,
        ),
      ),
    ).rejects.toThrow("boom")
    await lastValueFrom(
      interceptor.intercept(
        mockContext({ method: "POST", path: "/api/auth/login", headers: {}, body: { username: "admin", password: "demo1234" } }),
        mockHandler({ token: "t" }),
      ),
    )
    await settle()

    const page = await db.listAuditEvents({ page: 1, pageSize: 20 })
    expect(page.total).toBe(0)
  })

  it("x-actor 请求头作操作人；密码字段脱敏；entity/action 过滤", async () => {
    const { db, interceptor } = makeInterceptor()

    await lastValueFrom(
      interceptor.intercept(
        mockContext({
          method: "POST",
          path: "/api/principals",
          headers: { "x-actor": "sales" },
          body: { username: "u1", password: "secret123" },
        }),
        mockHandler({ id: "00000000-0000-4000-8000-000000000011" }),
      ),
    )
    await lastValueFrom(
      interceptor.intercept(
        mockContext({ method: "DELETE", path: "/api/customers/00000000-0000-4000-8000-000000000001", headers: {}, body: {} }),
        mockHandler({ ok: true }),
      ),
    )
    await settle()

    const all = await db.listAuditEvents({ page: 1, pageSize: 20 })
    expect(all.total).toBe(2)
    const created = all.items.find((e) => e.action === "POST /principals")!
    expect(created.actorId).toBe("sales")
    expect(created.payload?.detail).toContain("***")
    expect(created.payload?.detail).not.toContain("secret123")

    expect((await db.listAuditEvents({ page: 1, pageSize: 20, entity: "customers" })).total).toBe(1)
    expect((await db.listAuditEvents({ page: 1, pageSize: 20, entity: "principals" })).total).toBe(1)
    expect((await db.listAuditEvents({ page: 1, pageSize: 20, action: "POST" })).total).toBe(1)
    expect((await db.listAuditEvents({ page: 1, pageSize: 20, action: "DELETE" })).total).toBe(1)
    // 两条事件可能落在同一毫秒，倒序不断言先后，只断言集合齐全
    expect(all.items.map((e) => e.action).sort()).toEqual([
      "DELETE /customers/00000000-0000-4000-8000-000000000001",
      "POST /principals",
    ])
  })

  it("单据号优先取业务单号而非内部 id：退货取 rmaNo，客户取 code", async () => {
    const { db, interceptor } = makeInterceptor()
    await lastValueFrom(
      interceptor.intercept(
        mockContext({ method: "POST", path: "/api/rmas/00000000-0000-4000-8000-000000000001/reject", headers: {}, body: { reason: "无质量问题" } }),
        mockHandler({ id: "00000000-0000-4000-8000-000000000001", rmaNo: "RMA-MWJ14CGK" }),
      ),
    )
    await lastValueFrom(
      interceptor.intercept(
        mockContext({ method: "POST", path: "/api/customers", headers: {}, body: { code: "CUST-001", name: "华东贸易有限公司" } }),
        mockHandler({ id: "00000000-0000-4000-8000-000000000002", code: "CUST-001" }),
      ),
    )
    await settle()

    const page = await db.listAuditEvents({ page: 1, pageSize: 20 })
    expect(page.total).toBe(2)
    const byAction = new Map(page.items.map((e) => [e.action, e.targetId]))
    expect(byAction.get("POST /rmas/00000000-0000-4000-8000-000000000001/reject")).toBe("RMA-MWJ14CGK")
    expect(byAction.get("POST /customers")).toBe("CUST-001")
  })

  it("sales/orders 与 purchase/orders 的对象名取业务名而非首段", async () => {
    const { db, interceptor } = makeInterceptor()
    await lastValueFrom(
      interceptor.intercept(
        mockContext({ method: "POST", path: "/api/sales/orders", headers: {}, body: { lines: [] } }),
        mockHandler({ id: "00000000-0000-4000-8000-000000000002" }),
      ),
    )
    await lastValueFrom(
      interceptor.intercept(
        mockContext({ method: "POST", path: "/api/purchase/orders", headers: {}, body: {} }),
        mockHandler({ id: "00000000-0000-4000-8000-000000000003" }),
      ),
    )
    await settle()

    const salesEvents = await db.listAuditEvents({ page: 1, pageSize: 20, entity: "sales-orders" })
    expect(salesEvents.total).toBe(1)
    expect(salesEvents.items[0]!.action).toBe("POST /sales/orders")
    const purchaseEvents = await db.listAuditEvents({ page: 1, pageSize: 20, entity: "purchase-orders" })
    expect(purchaseEvents.total).toBe(1)
    expect(purchaseEvents.items[0]!.action).toBe("POST /purchase/orders")
  })
})
