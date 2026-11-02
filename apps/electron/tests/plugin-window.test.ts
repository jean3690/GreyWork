import { describe, expect, it } from "vitest";

import {
  MAX_PLUGIN_WINDOW_INSTANCES,
  parsePluginWindowLabel,
  pluginWindowLabel,
  pluginWindowOptions,
} from "../src/shared/plugin-window";

/**
 * 悬浮窗标签与形态（v2）：
 *  - 实例 1 的标签必须与 v1 逐字相同（渲染端 / 落盘几何都按 label 记账）；
 *  - 多开用 `::` 分隔 —— 插件 id 允许 `-` 与 `.`，用 `-` 会把 id 和后缀搅在一起；
 *  - 形态字段安装期已校验，这里再夹一次（手工改过 plugin.json 的包也不能开出空标题 / 全透明窗）。
 */

describe("pluginWindowLabel / parsePluginWindowLabel", () => {
  it("实例 1 保持 v1 形态，多开带 ::<n> 后缀", () => {
    expect(pluginWindowLabel("demo.pet")).toBe("plugin-window-demo.pet");
    expect(pluginWindowLabel("demo.pet", 1)).toBe("plugin-window-demo.pet");
    expect(pluginWindowLabel("demo.pet", 3)).toBe("plugin-window-demo.pet::3");
  });

  it("id 里带 - 或 . 也能原样往返（不能用 - 当实例分隔符的原因）", () => {
    for (const id of ["demo.pet-shop", "a.b-c_d"]) {
      expect(parsePluginWindowLabel(pluginWindowLabel(id))).toEqual({ pluginId: id, instance: 1 });
      expect(parsePluginWindowLabel(pluginWindowLabel(id, 2))).toEqual({ pluginId: id, instance: 2 });
    }
  });

  it("越界 / 非整数实例号夹到合法范围", () => {
    expect(pluginWindowLabel("demo.pet", 99)).toBe(`plugin-window-demo.pet::${MAX_PLUGIN_WINDOW_INSTANCES}`);
    expect(pluginWindowLabel("demo.pet", 0)).toBe("plugin-window-demo.pet");
    expect(pluginWindowLabel("demo.pet", 2.5)).toBe("plugin-window-demo.pet");
  });

  it("反解拒绝非悬浮窗标签与非法实例号", () => {
    expect(parsePluginWindowLabel("main")).toBeNull();
    expect(parsePluginWindowLabel("plugin-window-")).toBeNull();
    expect(parsePluginWindowLabel("plugin-window-demo.pet::0")).toBeNull();
    expect(parsePluginWindowLabel("plugin-window-demo.pet::x")).toBeNull();
    expect(parsePluginWindowLabel("plugin-window-demo.pet::9")).toBeNull();
  });
});

function pluginPackage(window: Record<string, unknown> | undefined, name = "Demo Pet"): unknown {
  return { schemaVersion: 1, manifest: { id: "demo.pet", name, window } };
}

describe("pluginWindowOptions", () => {
  it("缺省：置顶、不透明、单实例，标题取 manifest.name", () => {
    expect(pluginWindowOptions(pluginPackage({ width: 160, height: 140 }), "demo.pet")).toEqual({
      title: "Demo Pet",
      alwaysOnTop: true,
      opacity: 1,
      multiple: false,
    });
  });

  it("声明里的形态字段生效", () => {
    expect(
      pluginWindowOptions(pluginPackage({ width: 160, height: 140, title: "  桌面宠物 ", alwaysOnTop: false, opacity: 0.6, multiple: true }), "demo.pet"),
    ).toEqual({ title: "桌面宠物", alwaysOnTop: false, opacity: 0.6, multiple: true });
  });

  it("不透明度夹到 0.2-1，NaN 回落 1", () => {
    expect(pluginWindowOptions(pluginPackage({ width: 1, height: 1, opacity: 0.05 }), "id").opacity).toBe(0.2);
    expect(pluginWindowOptions(pluginPackage({ width: 1, height: 1, opacity: 3 }), "id").opacity).toBe(1);
    expect(pluginWindowOptions(pluginPackage({ width: 1, height: 1, opacity: Number.NaN }), "id").opacity).toBe(1);
  });

  it("标题非法（空 / 超长 / 控制字符 / 非字符串）回落到 name，再回落到 id", () => {
    expect(pluginWindowOptions(pluginPackage({ width: 1, height: 1, title: "   " }), "demo.pet").title).toBe("Demo Pet");
    expect(pluginWindowOptions(pluginPackage({ width: 1, height: 1, title: "标".repeat(65) }), "demo.pet").title).toBe("Demo Pet");
    expect(pluginWindowOptions(pluginPackage({ width: 1, height: 1, title: "a\u0007b" }), "demo.pet").title).toBe("Demo Pet");
    expect(pluginWindowOptions(pluginPackage({ width: 1, height: 1, title: 42 }), "demo.pet").title).toBe("Demo Pet");
    // 连 name 都没有（手工残包）：用插件 id 兜底，标题栏不至于空白。
    expect(pluginWindowOptions({ manifest: { id: "demo.pet", window: { width: 1, height: 1 } } }, "demo.pet").title).toBe("demo.pet");
  });

  it("multiple 只认严格的 true（字符串 'true' 不算）", () => {
    expect(pluginWindowOptions(pluginPackage({ width: 1, height: 1, multiple: "true" }), "id").multiple).toBe(false);
    expect(pluginWindowOptions(pluginPackage({ width: 1, height: 1, multiple: true }), "id").multiple).toBe(true);
  });
});
