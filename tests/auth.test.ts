import { ExecutionContext } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import jwt from "jsonwebtoken"
import "reflect-metadata"
import { describe, expect, it } from "vitest"
import { IamService } from "../src/application/iam.service"
import { InMemoryDatabase } from "../src/infrastructure/in-memory.database"
import { AuthGuard, PUBLIC_KEY } from "../src/interface/http/auth.guard"

/** 内存种子：admin [admin]、sales [sales]、viewer [readonly]，密码均为 demo1234 */
function makeGuard() {
  const db = new InMemoryDatabase()
  const iam = new IamService(db)
  return { iam, guard: new AuthGuard(new Reflector(), iam) }
}

// vitest 的 esbuild 默认不支持装饰器：@Public() 的元数据改用 Reflect.defineMetadata 手工挂，
// 与 SetMetadata(PUBLIC_KEY, true) 完全等价，Reflector 照常读到。
function publicHandler() {}
Reflect.defineMetadata(PUBLIC_KEY, true, publicHandler)

function guardedHandler() {}

class GuardedController {
  guarded() {}
}

/** 伪造 ExecutionContext：只给守卫用到的三个方法 */
function fakeContext(handler: (...args: unknown[]) => unknown, req: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => GuardedController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext
}

function req(method: string, path: string, authorization?: string) {
  return { method, path, headers: authorization ? { authorization } : {} }
}

describe("AuthGuard", () => {
  it("公开路由无 token 放行；OPTIONS 预检无 token 放行", async () => {
    const { guard } = makeGuard()
    const openCtx = {
      getHandler: () => publicHandler,
      getClass: () => GuardedController,
      switchToHttp: () => ({ getRequest: () => req("GET", "/api/health") }),
    } as unknown as ExecutionContext
    await expect(guard.canActivate(openCtx)).resolves.toBe(true)

    const optionsCtx = fakeContext(guardedHandler, req("OPTIONS", "/api/customers"))
    await expect(guard.canActivate(optionsCtx)).resolves.toBe(true)
  })

  it("缺 token、错 token、过期 token 都报 401", async () => {
    const { iam, guard } = makeGuard()
    const ctx = fakeContext(guardedHandler, req("GET", "/api/customers"))
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 })

    const badCtx = fakeContext(guardedHandler, req("GET", "/api/customers", "Bearer not-a-token"))
    await expect(guard.canActivate(badCtx)).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 })

    // 过期 token：用非生产回退密钥签一个已过期的（与 iam.service.ts 的 jwtSecret() 同口径）
    const expired = jwt.sign(
      { sub: "x", username: "admin", roles: ["admin"], exp: Math.floor(Date.now() / 1000) - 60 },
      "dev-only-insecure-secret",
    )
    const expiredCtx = fakeContext(
      guardedHandler,
      req("GET", "/api/customers", `Bearer ${expired}`),
    )
    await expect(guard.canActivate(expiredCtx)).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 })
    void iam
  })

  it("admin 全放行，守卫把主体挂 req.user", async () => {
    const { iam, guard } = makeGuard()
    const { accessToken } = await iam.login({ username: "admin", password: "demo1234" })
    const getReq = req("GET", "/api/customers", `Bearer ${accessToken}`)
    await expect(guard.canActivate(fakeContext(guardedHandler, getReq))).resolves.toBe(true)
    expect((getReq as { user?: { username?: string } }).user?.username).toBe("admin")

    const postReq = req("POST", "/api/iam/principals", `Bearer ${accessToken}`)
    await expect(guard.canActivate(fakeContext(guardedHandler, postReq))).resolves.toBe(true)
  })

  it("sales 能读写业务接口，但禁 /iam/*", async () => {
    const { iam, guard } = makeGuard()
    const { accessToken } = await iam.login({ username: "sales", password: "demo1234" })
    const bearer = `Bearer ${accessToken}`
    await expect(
      guard.canActivate(fakeContext(guardedHandler, req("POST", "/api/customers", bearer))),
    ).resolves.toBe(true)
    await expect(
      guard.canActivate(fakeContext(guardedHandler, req("GET", "/api/iam/principals", bearer))),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 })
    await expect(
      guard.canActivate(fakeContext(guardedHandler, req("POST", "/api/iam/principals", bearer))),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 })
  })

  it("第 8 批：sales 能读审批规则、但禁写（否则自己改门槛就绕过了规则）", async () => {
    const { iam, guard } = makeGuard()
    const { accessToken } = await iam.login({ username: "sales", password: "demo1234" })
    const bearer = `Bearer ${accessToken}`
    await expect(
      guard.canActivate(fakeContext(guardedHandler, req("GET", "/api/approval-rules", bearer))),
    ).resolves.toBe(true)
    await expect(
      guard.canActivate(fakeContext(guardedHandler, req("PATCH", "/api/approval-rules/00000000-0000-4000-8000-000000000701", bearer))),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 })
    const { accessToken: adminToken } = await iam.login({ username: "admin", password: "demo1234" })
    await expect(
      guard.canActivate(fakeContext(guardedHandler, req("PATCH", "/api/approval-rules/00000000-0000-4000-8000-000000000701", `Bearer ${adminToken}`))),
    ).resolves.toBe(true)
  })

  it("只读角色仅 GET，写操作报 403", async () => {
    const { iam, guard } = makeGuard()
    const { accessToken } = await iam.login({ username: "viewer", password: "demo1234" })
    const bearer = `Bearer ${accessToken}`
    await expect(
      guard.canActivate(fakeContext(guardedHandler, req("GET", "/api/customers", bearer))),
    ).resolves.toBe(true)
    await expect(
      guard.canActivate(fakeContext(guardedHandler, req("POST", "/api/customers", bearer))),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 })
    await expect(
      guard.canActivate(fakeContext(guardedHandler, req("DELETE", "/api/customers/x", bearer))),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 })
  })
})
