// cron 语义契约：解析 / 校验 / 人类描述 / 下次运行预览。
// 这些断言与宿主侧 src-tauri/src/cron.rs 的单测一一对应（两份实现必须同语义）。

import { describe, expect, it } from "vitest";
import { composeCron, decomposeCron, describeCron, nextCronRuns, parseCron, validateCron } from "@/lib/cron";
import { i18n, setLocale } from "@/i18n";

describe("parseCron", () => {
  it("解析基本字段并规范化空白", () => {
    const spec = parseCron("  0   9  *  *  * ");
    expect(spec?.normalized).toBe("0 9 * * *");
    expect(spec?.minutes).toEqual([0]);
    expect(spec?.hours).toEqual([9]);
    expect(spec?.months).toHaveLength(12);
  });

  it("支持列表 / 区间 / 步进 / 名称", () => {
    expect(parseCron("0 9,18 * * *")?.hours).toEqual([9, 18]);
    expect(parseCron("0 9-11 * * *")?.hours).toEqual([9, 10, 11]);
    expect(parseCron("*/15 * * * *")?.minutes).toEqual([0, 15, 30, 45]);
    expect(parseCron("0 0-6/2 * * *")?.hours).toEqual([0, 2, 4, 6]);
    expect(parseCron("0 0 * JAN-MAR *")?.months).toEqual([1, 2, 3]);
    expect(parseCron("0 0 * * MON-FRI")?.weekdays).toEqual([1, 2, 3, 4, 5]);
  });

  it("周 7 与 0 都是周日", () => {
    expect(parseCron("0 0 * * 7")?.weekdays).toEqual([0]);
    expect(parseCron("0 0 * * 0")?.weekdays).toEqual([0]);
    expect(parseCron("0 0 * * 5-7")?.weekdays).toEqual([0, 5, 6]);
  });

  it("宏展开为 5 段", () => {
    expect(parseCron("@daily")?.normalized).toBe("0 0 * * *");
    expect(parseCron("@HOURLY")?.minutes).toEqual([0]);
    expect(parseCron("@weekly")?.weekdays).toEqual([0]);
  });

  it("非法表达式返回 null（段数 / 越界 / 步进 0 / 空列表项）", () => {
    expect(parseCron("")).toBeNull();
    expect(parseCron("0 9 * *")).toBeNull();
    expect(parseCron("0 9 * * * *")).toBeNull();
    expect(parseCron("60 9 * * *")).toBeNull();
    expect(parseCron("0 24 * * *")).toBeNull();
    expect(parseCron("0 0 32 * *")).toBeNull();
    expect(parseCron("0 0 * 13 *")).toBeNull();
    expect(parseCron("0 0 * * 8")).toBeNull();
    expect(parseCron("*/0 * * * *")).toBeNull();
    expect(parseCron("0 9,,10 * * *")).toBeNull();
    expect(parseCron("x 9 * * *")).toBeNull();
  });

  it("日 / 周字段的受限标记只认 `*` 开头", () => {
    expect(parseCron("0 9 * * 1")?.weekdaysRestricted).toBe(true);
    expect(parseCron("0 9 * * *")?.weekdaysRestricted).toBe(false);
    // `*/2` 按 Vixie cron 语义算「自由」字段（星号开头）
    expect(parseCron("0 9 */2 * *")?.daysRestricted).toBe(false);
    expect(parseCron("0 9 1 * *")?.daysRestricted).toBe(true);
  });
});

describe("validateCron", () => {
  it("合法表达式无错误", () => {
    expect(validateCron("0 9 * * 1-5")).toBeNull();
    expect(validateCron("@daily")).toBeNull();
  });

  it("错误按字段归因，供界面就地标红", () => {
    expect(validateCron("  ")?.messageKey).toBe("errorEmpty");
    expect(validateCron("0 9 * *")?.messageKey).toBe("errorFields");
    const range = validateCron("0 99 * * *");
    expect(range?.messageKey).toBe("errorField");
    expect(range?.field).toBe("hour");
    expect(range?.max).toBe(23);
    expect(validateCron("0 0 * * 9")?.field).toBe("weekday");
  });
});

describe("nextCronRuns", () => {
  const at = (text: string): Date => new Date(text);

  it("每日定点：正落在整分时含当前分钟，否则从下一分钟起", () => {
    expect(nextCronRuns("0 9 * * *", at("2026-09-14T09:00:00"), 1)[0]?.toISOString()).toBe(new Date("2026-09-14T09:00:00").toISOString());
    const later = nextCronRuns("0 9 * * *", at("2026-09-14T09:00:01"), 2);
    expect(later[0]?.getDate()).toBe(15);
    expect(later[1]?.getDate()).toBe(16);
  });

  it("跨月推进：每月 1 日 08:30", () => {
    const runs = nextCronRuns("30 8 1 * *", at("2026-09-14T10:00:00"), 2);
    expect(runs.map((run) => run.toISOString())).toEqual([
      new Date("2026-10-01T08:30:00").toISOString(),
      new Date("2026-11-01T08:30:00").toISOString(),
    ]);
  });

  it("周字段为标准 cron 语义（0/7 = 周日、5 = 周五）", () => {
    const friday = nextCronRuns("0 18 * * 5", at("2026-09-14T00:00:00"), 2);
    expect(friday.map((run) => [run.getDay(), run.getHours(), run.getMinutes()])).toEqual([
      [5, 18, 0],
      [5, 18, 0],
    ]);
    expect(friday[0]?.toISOString()).toBe(new Date("2026-09-18T18:00:00").toISOString());
    // 周日 00:00：0 与 7 等价
    expect(nextCronRuns("0 0 * * 7", at("2026-09-14T00:00:00"), 1)[0]?.getDay()).toBe(0);
  });

  it("日 / 周同时受限按 OR（标准 cron）", () => {
    // 每月 1 日或每周一 09:00（2026-09-14 是周一）
    const runs = nextCronRuns("0 9 1 * 1", at("2026-09-14T00:00:00"), 3);
    expect(runs.map((run) => run.toISOString())).toEqual([
      new Date("2026-09-14T09:00:00").toISOString(),
      new Date("2026-09-21T09:00:00").toISOString(),
      new Date("2026-09-28T09:00:00").toISOString(),
    ]);
  });

  it("步进：每 15 分钟", () => {
    const runs = nextCronRuns("*/15 * * * *", at("2026-09-14T10:05:30"), 3);
    expect(runs.map((run) => run.getMinutes())).toEqual([15, 30, 45]);
  });

  it("无解表达式在扫描上限内返回空（不抛错）", () => {
    expect(nextCronRuns("0 0 30 2 *", at("2026-09-14T00:00:00"), 1)).toEqual([]);
    expect(nextCronRuns("0 9 * *", at("2026-09-14T00:00:00"), 1)).toEqual([]);
  });
});

describe("composeCron / decomposeCron", () => {
  it("结构化输入往返", () => {
    expect(composeCron({ kind: "manual" })).toBeNull();
    expect(composeCron({ kind: "daily", hour: 9, minute: 0 })).toBe("0 9 * * *");
    expect(composeCron({ kind: "weekly", days: [5, 1], hour: 18, minute: 30 })).toBe("30 18 * * 1,5");
    expect(composeCron({ kind: "weekly", days: [], hour: 18, minute: 0 })).toBeNull();
    expect(composeCron({ kind: "monthly", day: 1, hour: 8, minute: 30 })).toBe("30 8 1 * *");
    expect(composeCron({ kind: "yearly", month: 1, day: 20, hour: 9, minute: 0 })).toBe("0 9 20 1 *");
    // 一次性任务不折算成 cron：cron 没有年份字段，「每年这天」不是「只跑一次」
    expect(composeCron({ kind: "once", at: 1_800_000_000_000 })).toBeNull();
    expect(composeCron({ kind: "interval", unit: "minute", every: 15 })).toBe("*/15 * * * *");
    expect(composeCron({ kind: "interval", unit: "hour", every: 2 })).toBe("0 */2 * * *");
    expect(composeCron({ kind: "cron", expr: " 0 9 * * 1,3 " })).toBe("0 9 * * 1,3");
  });

  it("反解回结构；解不出的保留原始表达式", () => {
    expect(decomposeCron(null)).toEqual({ kind: "manual" });
    expect(decomposeCron("")).toEqual({ kind: "manual" });
    expect(decomposeCron("0 9 * * *")).toEqual({ kind: "daily", hour: 9, minute: 0 });
    expect(decomposeCron("30 18 * * 5,1")).toEqual({ kind: "weekly", days: [1, 5], hour: 18, minute: 30 });
    expect(decomposeCron("30 8 1 * *")).toEqual({ kind: "monthly", day: 1, hour: 8, minute: 30 });
    expect(decomposeCron("0 9 20 1 *")).toEqual({ kind: "yearly", month: 1, day: 20, hour: 9, minute: 0 });
    // 一次性任务由 onceAt 承载：即便 cron 脏了也不排成循环任务
    expect(decomposeCron(null, 1_800_000_000_000)).toEqual({ kind: "once", at: 1_800_000_000_000 });
    expect(decomposeCron("0 9 * * *", 0)).toEqual({ kind: "daily", hour: 9, minute: 0 });
    expect(decomposeCron("*/15 * * * *")).toEqual({ kind: "interval", unit: "minute", every: 15 });
    expect(decomposeCron("0 */2 * * *")).toEqual({ kind: "interval", unit: "hour", every: 2 });
    expect(decomposeCron("@daily")).toEqual({ kind: "daily", hour: 0, minute: 0 });
    // 复杂表达式 / 非法表达式：原样保留，绝不改写
    expect(decomposeCron("0 9 1,15 * *")).toEqual({ kind: "cron", expr: "0 9 1,15 * *" });
    expect(decomposeCron("0 9 * * MON")).toEqual({ kind: "cron", expr: "0 9 * * MON" });
    expect(decomposeCron("0 9 * *")).toEqual({ kind: "cron", expr: "0 9 * *" });
  });
});

describe("describeCron", () => {
  it("中文常见形态", () => {
    setLocale("zh-CN");
    expect(describeCron("0 9 * * *")).toBe("每天 09:00");
    expect(describeCron("30 18 * * 5")).toBe("每周五 18:30");
    expect(describeCron("0 18 * * 1,3,5")).toBe("每周一、三、五 18:00");
    expect(describeCron("30 8 1 * *")).toBe("每月 1 日 08:30");
    expect(describeCron("*/15 * * * *")).toBe("每 15 分钟");
    expect(describeCron("0 */2 * * *")).toBe("每 2 小时");
    expect(describeCron("0 0 1 1 *")).toBe("每年 1 月 1 日 00:00");
    expect(describeCron("0 9 1,15 * *")).toBeNull();
    expect(describeCron("0 9 * *")).toBeNull();
  });

  it("英文形态", () => {
    setLocale("en-US");
    expect(describeCron("0 9 * * *")).toBe("Every day at 09:00");
    expect(describeCron("0 18 * * 5")).toBe("Every Fri at 18:00");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    setLocale("zh-CN");
  });

  it("描述与全局 locale 同步（不在导入时固化）", () => {
    const original = i18n.global.locale.value;
    setLocale("en-US");
    const english = describeCron("0 9 * * *");
    setLocale("zh-CN");
    expect(describeCron("0 9 * * *")).not.toBe(english);
    setLocale(original as "zh-CN" | "en-US");
  });
});
