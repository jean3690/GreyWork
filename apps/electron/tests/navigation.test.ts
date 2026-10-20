import { describe, expect, it } from "vitest";

import { isExternalHttpUrl, isSameOrigin } from "../src/shared/navigation";

describe("导航 origin 判定", () => {
  it("同源包含路径 / 查询 / hash，不包含端口或协议差异", () => {
    const origin = "http://127.0.0.1:17844";
    expect(isSameOrigin(`${origin}/`, origin)).toBe(true);
    expect(isSameOrigin(`${origin}/#/settings`, origin)).toBe(true);
    expect(isSameOrigin(`${origin}/api/health?x=1`, origin)).toBe(true);
    expect(isSameOrigin("http://127.0.0.1:17845/", origin)).toBe(false);
    expect(isSameOrigin("http://localhost:17844/", origin)).toBe(false);
    expect(isSameOrigin("https://127.0.0.1:17844/", origin)).toBe(false);
  });

  it("非法输入一律不信任", () => {
    expect(isSameOrigin("", "http://127.0.0.1:17844")).toBe(false);
    expect(isSameOrigin("not a url", "http://127.0.0.1:17844")).toBe(false);
    expect(isSameOrigin("http://127.0.0.1:17844", "")).toBe(false);
  });

  it("只有 http(s) 可以交给系统浏览器", () => {
    expect(isExternalHttpUrl("https://example.com/a")).toBe(true);
    expect(isExternalHttpUrl("http://example.com")).toBe(true);
    expect(isExternalHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isExternalHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isExternalHttpUrl("mailto:a@b.c")).toBe(false);
    expect(isExternalHttpUrl("")).toBe(false);
  });
});
