/**
 * 侧栏导航清单：前端特性贡献的入口固定在前，插件 modes 追加在后。
 * Sider / MinimalSider / 标题栏搜索共用这一份，所以顺序与兜底图标都要锁住。
 *
 * 注意这里的「固定三项」现在断言的是**默认全量前端**贡献的入口 —— 它同时是
 * 「拆分前后导航项没变」的回归锁。特性自己带 nav 之后，这条断言就是两者的连接点。
 */
import { describe, expect, it } from "vitest";
import { ALL_FEATURES_FRONT } from "@/front/all";
import type { FrontSpec } from "@/front/types";
import { builtinNavItems, buildNavItems, pluginNavItems } from "@/lib/nav-items";

/** 从默认前端里去掉若干特性，模拟一个更窄的前端。 */
function frontWithout(...ids: readonly string[]): FrontSpec {
  return { ...ALL_FEATURES_FRONT, features: ALL_FEATURES_FRONT.features.filter((feature) => !ids.includes(feature.id)) };
}

describe("nav-items", () => {
  it("默认前端的入口固定三项且顺序稳定", () => {
    expect(builtinNavItems(ALL_FEATURES_FRONT).map((item) => item.path)).toEqual(["/assistants", "/scheduled", "/team"]);
  });

  it("前端未启用的特性不贡献入口（去掉 team 就少一项，且顺序不乱）", () => {
    expect(builtinNavItems(frontWithout("team")).map((item) => item.path)).toEqual(["/assistants", "/scheduled"]);
  });

  it("不带 nav 的特性（guid / conversation / channels / plugins）不进侧栏", () => {
    const paths = builtinNavItems(ALL_FEATURES_FRONT).map((item) => item.path);
    for (const id of ["guid", "conversation", "channels", "plugins"]) {
      expect(paths).not.toContain(`/${id}`);
    }
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

  it("完整清单 = 前端入口 + 插件", () => {
    const items = buildNavItems([{ id: "canvas", title: "画布" }], ALL_FEATURES_FRONT);
    expect(items).toHaveLength(builtinNavItems(ALL_FEATURES_FRONT).length + 1);
    expect(items.at(-1)?.path).toBe("/plugin/canvas");
  });
});
