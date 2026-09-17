/**
 * 侧栏导航清单：内置项固定在前，插件 modes 追加在后。
 * Sider 与标题栏搜索共用这一份，所以顺序与兜底图标都要锁住。
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_NAV_ITEMS, buildNavItems, pluginNavItems } from "@/lib/nav-items";

describe("nav-items", () => {
  it("内置入口固定三项且顺序稳定", () => {
    expect(BUILTIN_NAV_ITEMS.map((item) => item.path)).toEqual(["/assistants", "/scheduled", "/team"]);
  });

  it("插件 modes 映射成 /plugin/:id，图标缺省回落 magic", () => {
    expect(
      pluginNavItems([
        { id: "canvas", title: "画布" },
        { id: "db", title: "数据库", icon: "folder" },
      ]),
    ).toEqual([
      { path: "/plugin/canvas", label: "画布", icon: "magic" },
      { path: "/plugin/db", label: "数据库", icon: "folder" },
    ]);
  });

  it("完整清单 = 内置 + 插件", () => {
    const items = buildNavItems([{ id: "canvas", title: "画布" }]);
    expect(items).toHaveLength(BUILTIN_NAV_ITEMS.length + 1);
    expect(items.at(-1)?.path).toBe("/plugin/canvas");
  });
});
