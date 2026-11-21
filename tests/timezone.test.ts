import { describe, expect, it } from "vitest"
import { addDays, dateInTimezone, dayStartMsInTimezone, todayInTimezone, tzOffsetMs } from "../src/domain/timezone"

describe("timezone helpers（租户时区 Asia/Shanghai）", () => {
  it("dateInTimezone：02:00 CST 算第二天", () => {
    expect(dateInTimezone("2026-11-20T18:00:00.000Z")).toBe("2026-11-21")
    expect(dateInTimezone("2026-11-20T15:59:00.000Z")).toBe("2026-11-20")
    expect(dateInTimezone("2026-11-20T16:00:00.000Z")).toBe("2026-11-21")
    expect(dateInTimezone("2026-11-21T00:00:00.000Z")).toBe("2026-11-21")
  })

  it("dayStartMsInTimezone：11-21 00:00 CST = 11-20 16:00 UTC", () => {
    expect(dayStartMsInTimezone("2026-11-21")).toBe(Date.parse("2026-11-20T16:00:00.000Z"))
    expect(dayStartMsInTimezone("2026-11-21") + 86400000).toBe(dayStartMsInTimezone("2026-11-22"))
  })

  it("tzOffsetMs：上海 +8 小时", () => {
    expect(tzOffsetMs("Asia/Shanghai", Date.parse("2026-11-21T00:00:00.000Z"))).toBe(8 * 3600000)
  })

  it("todayInTimezone：按传入时间算", () => {
    expect(todayInTimezone("Asia/Shanghai", new Date("2026-11-20T18:00:00.000Z"))).toBe("2026-11-21")
    expect(todayInTimezone("Asia/Shanghai", new Date("2026-11-20T15:00:00.000Z"))).toBe("2026-11-20")
  })

  it("addDays：跨月跨年", () => {
    expect(addDays("2026-11-21", 1)).toBe("2026-11-22")
    expect(addDays("2026-11-21", -1)).toBe("2026-11-20")
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
  })
})
