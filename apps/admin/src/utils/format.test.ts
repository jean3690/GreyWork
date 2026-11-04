import { describe, expect, it } from "vitest";
import { actionMeta, formatDate, formatDateTime, formatNumber, formatTokens, platformLabel } from "./format";

describe("formatDateTime", () => {
  it("空值与非法值不抛错", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
  });

  it("格式化 ISO 本地时间", () => {
    expect(formatDateTime("2026-11-03T09:04:05")).toBe("2026/11/03 09:04:05");
  });
});

describe("formatDate", () => {
  it("纯日期按字面切分，不做 UTC 换算", () => {
    expect(formatDate("2026-11-03")).toBe("11/3");
    expect(formatDate("2026-01-09")).toBe("1/9");
  });

  it("空值回占位符", () => {
    expect(formatDate(null)).toBe("—");
  });
});

describe("formatTokens / formatNumber", () => {
  it("按量级压缩 token", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1500)).toBe("1.5K");
    expect(formatTokens(10000)).toBe("10K");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(12_000_000)).toBe("12M");
  });

  it("千分位", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatNumber(null)).toBe("0");
  });
});

describe("platform / action 映射", () => {
  it("已知平台走中文名，未知值原样返回", () => {
    expect(platformLabel("wechat")).toBe("微信");
    expect(platformLabel("telegram")).toBe("Telegram");
    expect(platformLabel("custom-platform")).toBe("custom-platform");
    expect(platformLabel(null)).toBe("—");
  });

  it("审计动作有中文名与颜色档，未知动作不崩", () => {
    expect(actionMeta("user_disable")).toEqual({ label: "禁用用户", tone: "danger" });
    expect(actionMeta("admin_login").label).toBe("运维台登录");
    expect(actionMeta("some_new_action")).toEqual({ label: "some_new_action", tone: "info" });
  });
});
