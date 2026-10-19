import { describe, expect, it } from "vitest";

import { exitShouldBlock, setUnsaved, shouldInterceptExit } from "../src/main/close-guard";

describe("退出守卫", () => {
  it("只有「有脏改动 + 未放行 + 窗口还在」才拦退出", () => {
    expect(exitShouldBlock(true, false, true)).toBe(true);
    // 窗口已销毁：弹不出确认层，宁可放行，不能把应用卡死。
    expect(exitShouldBlock(true, false, false)).toBe(false);
    // 渲染端已确认 / 兜底放行。
    expect(exitShouldBlock(true, true, true)).toBe(false);
    expect(exitShouldBlock(false, false, true)).toBe(false);
  });

  it("模块状态版读到渲染端同步的脏标记", () => {
    expect(shouldInterceptExit(true)).toBe(false);
    setUnsaved(true);
    expect(shouldInterceptExit(true)).toBe(true);
    // 没有窗口时仍不拦。
    expect(shouldInterceptExit(false)).toBe(false);
    setUnsaved(false);
    expect(shouldInterceptExit(true)).toBe(false);
  });
});
