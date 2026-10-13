import { describe, expect, it } from "vitest";

import { canOpenPluginWindow, clampWindowSize, declaresWindowFloating } from "../src/shared/plugin-eligibility";

/**
 * 与 Rust 侧 `can_open_plugin_window` 同口径：worker 包 + render 循环 + window 声明
 * + `requires` 含 `window.floating`。用例形状照 Rust 测试里的 `worker_manifest` 抄。
 */
function pluginPackage(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    manifest: {
      id: "demo.pet",
      name: "Demo Pet",
      version: "1.0.0",
      kind: "worker",
      runtime: {
        runtimeType: "worker",
        entry: "https://example.com/demo.js",
        sha256: "a".repeat(64),
        render: { handler: "draw", fps: 12 },
      },
      requires: ["window.floating"],
      window: { width: 160, height: 150 },
      ...overrides,
    },
  };
}

describe("canOpenPluginWindow", () => {
  it("四件齐全才放行", () => {
    expect(canOpenPluginWindow(pluginPackage())).toBe(true);
  });

  it("缺任一条即拒", () => {
    expect(canOpenPluginWindow(pluginPackage({ kind: "declarative" }))).toBe(false);
    expect(canOpenPluginWindow(pluginPackage({ window: null }))).toBe(false);
    expect(canOpenPluginWindow(pluginPackage({ runtime: { entry: "x" } }))).toBe(false);
    expect(canOpenPluginWindow(pluginPackage({ requires: ["net.fetch"] }))).toBe(false);
  });

  it("垃圾输入一律拒（不抛）", () => {
    expect(canOpenPluginWindow(null)).toBe(false);
    expect(canOpenPluginWindow(undefined)).toBe(false);
    expect(canOpenPluginWindow("x")).toBe(false);
    expect(canOpenPluginWindow({})).toBe(false);
    expect(canOpenPluginWindow({ manifest: null })).toBe(false);
  });
});

describe("declaresWindowFloating", () => {
  it("字符串项与带 capability 的对象项都认", () => {
    expect(declaresWindowFloating(["window.floating"])).toBe(true);
    expect(declaresWindowFloating([{ capability: "window.floating", max: 1 }])).toBe(true);
    expect(declaresWindowFloating(["net.fetch"])).toBe(false);
    expect(declaresWindowFloating(undefined)).toBe(false);
  });
});

describe("clampWindowSize", () => {
  it("夹到 1–512 并取整", () => {
    expect(clampWindowSize(160)).toBe(160);
    expect(clampWindowSize(160.6)).toBe(161);
    expect(clampWindowSize(0)).toBe(1);
    expect(clampWindowSize(9999)).toBe(512);
    expect(clampWindowSize(undefined)).toBe(1);
    expect(clampWindowSize("160")).toBe(1);
  });
});
