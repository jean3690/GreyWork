/**
 * 模型供应商自定义 headers 的文本编解码：非法行整体拒绝（与 parseEnvText 同语义），
 * 值可含冒号（只在首个 `:` 处切分）。这是「网关 401 却查不到原因」类故障的第一道护栏。
 */
import { describe, expect, it } from "vitest";
import { formatHeaderText, parseHeaderText } from "@/stores/agent/shared";

describe("parseHeaderText", () => {
  it("每行一条 Key: Value；空行与 # 注释忽略", () => {
    const { headers, error } = parseHeaderText("X-Org: acme\n\n# comment\nX-Trace: 1");
    expect(error).toBeNull();
    expect(headers).toEqual({ "X-Org": "acme", "X-Trace": "1" });
  });

  it("值可含冒号（只在首个冒号切分）", () => {
    const { headers, error } = parseHeaderText("X-Time: 12:30:00");
    expect(error).toBeNull();
    expect(headers).toEqual({ "X-Time": "12:30:00" });
  });

  it("非法行整体拒绝：无冒号、空 key、空 value", () => {
    expect(parseHeaderText("no-colon").error).not.toBeNull();
    expect(parseHeaderText(": value").error).not.toBeNull();
    expect(parseHeaderText("X-Empty: ").error).not.toBeNull();
    // 拒绝时不产出半份结果
    const rejected = parseHeaderText("X-Ok: 1\nbroken-line");
    expect(rejected.headers).toEqual({});
    expect(rejected.error).toContain("broken-line");
  });

  it("空文本得到空映射（无附加头）", () => {
    const { headers, error } = parseHeaderText("");
    expect(error).toBeNull();
    expect(headers).toEqual({});
  });
});

describe("formatHeaderText", () => {
  it("映射 → 每行 Key: Value；undefined → 空串", () => {
    expect(formatHeaderText({ A: "1", B: "2" })).toBe("A: 1\nB: 2");
    expect(formatHeaderText(undefined)).toBe("");
  });

  it("parse → format → parse 往返稳定", () => {
    const text = "X-Org: acme\nX-Auth: {{MY_TOKEN}}";
    const parsed = parseHeaderText(text);
    expect(parsed.error).toBeNull();
    expect(parseHeaderText(formatHeaderText(parsed.headers)).headers).toEqual(parsed.headers);
  });
});
