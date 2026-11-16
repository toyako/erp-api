import { describe, expect, it } from "vitest"
import { IamService } from "../src/application/iam.service"
import { DomainError } from "../src/domain/ports"
import { InMemoryDatabase } from "../src/infrastructure/in-memory.database"

function makeServices() {
  const db = new InMemoryDatabase()
  return { db, iam: new IamService(db) }
}

describe("IamService", () => {
  it("新建用户成功，新密码能登录；用户名重复报 409", async () => {
    const { iam } = makeServices()
    const created = await iam.createPrincipal({ username: "ops", password: "ops12345", displayName: "运营", roles: ["sales"] })
    expect(created.username).toBe("ops")
    expect(created.roles).toEqual(["sales"])

    const logged = await iam.login({ username: "ops", password: "ops12345" })
    expect(logged.principal.username).toBe("ops")
    expect(logged.accessToken.length).toBeGreaterThan(0)

    await expect(
      iam.createPrincipal({ username: "ops", password: "ops12345", displayName: "重复", roles: ["sales"] })
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
  })

  it("重置密码后旧密码登录失败、新密码能登录；改角色即时生效", async () => {
    const { iam } = makeServices()
    const created = await iam.createPrincipal({ username: "ops", password: "ops12345", displayName: "运营", roles: ["sales"] })

    const renamed = await iam.updatePrincipal(created.id, { displayName: "运营主管", roles: ["admin", "sales"] })
    expect(renamed.displayName).toBe("运营主管")
    expect(renamed.roles).toEqual(["admin", "sales"])

    const reset = await iam.updatePrincipal(created.id, { password: "newpass9" })
    expect(reset.username).toBe("ops")
    await expect(iam.login({ username: "ops", password: "ops12345" })).rejects.toMatchObject({ code: "FORBIDDEN", status: 401 })
    const logged = await iam.login({ username: "ops", password: "newpass9" })
    expect(logged.principal.roles).toEqual(["admin", "sales"])
  })

  it("空改报 400，查不到的用户报 404", async () => {
    const { iam } = makeServices()
    const created = await iam.createPrincipal({ username: "ops", password: "ops12345", displayName: "运营", roles: ["sales"] })
    await expect(iam.updatePrincipal(created.id, {})).rejects.toMatchObject({ code: "INVALID_STATE", status: 400 })
    await expect(
      iam.updatePrincipal("00000000-0000-4000-8000-000000000999", { displayName: "无" })
    ).rejects.toBeInstanceOf(DomainError)
  })

  it("用户列表分页：种子 3 人，新建后 4 人", async () => {
    const { iam } = makeServices()
    const before = await iam.listPrincipals({ page: 1, pageSize: 20 })
    expect(before.total).toBe(3)
    await iam.createPrincipal({ username: "ops", password: "ops12345", displayName: "运营", roles: ["sales"] })
    const after = await iam.listPrincipals({ page: 1, pageSize: 20 })
    expect(after.total).toBe(4)
    const p2 = await iam.listPrincipals({ page: 2, pageSize: 3 })
    expect(p2.items).toHaveLength(1)
    expect(p2.total).toBe(4)
  })
})
