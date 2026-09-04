// capability loader：注册表驱动 —— 追加 manifest 后 snapshot 即含新 mode，
// deactivate 后移除，且被依赖时拒绝。旧壳的 coreBuiltinManifest 已随旧前端删除，
// 此处用内联 manifest 验证 loader 机制本身。
import { describe, expect, it } from "vitest";
import { defineComponent } from "vue";
import { createCapabilityLoader, DuplicatePluginError } from "@/plugins/loader";
import type { PluginManifest } from "@/plugins/types";

const Dummy = defineComponent({ render: () => null });

const builtin: PluginManifest = {
  id: "core.builtin",
  name: "GreyWork 内置能力",
  version: "0.1.0",
  contributes: {
    modes: [
      { id: "chat", title: "nav.modes.chat", component: Dummy },
      { id: "workspaces", title: "nav.modes.workspaces", component: Dummy },
    ],
    uiRegions: [{ region: "shellSidebar", id: "sidebar.entries", title: "sidebar.entries", component: Dummy, order: 10 }],
  },
};

describe("capability loader", () => {
  it("registers default manifest and exposes builtin modes", async () => {
    const loader = createCapabilityLoader();
    loader.register(builtin);
    await loader.activateAll();
    const modes = loader.snapshot().modes.map((mode) => mode.id);
    expect(modes).toHaveLength(2);
    expect(modes).toContain("chat");
    expect(modes).toContain("workspaces");
    expect(loader.snapshot().uiRegions.filter((region) => region.region === "shellSidebar")).toHaveLength(1);
  });

  it("accepts an 11th plugin mode without touching router or core components", async () => {
    const loader = createCapabilityLoader();
    loader.register(builtin);
    await loader.activateAll();
    loader.register({
      id: "ext.demo",
      name: "Demo 插件视图",
      version: "0.1.0",
      contributes: { modes: [{ id: "demo", title: "演示", component: Dummy }] },
    });
    await loader.activate("ext.demo");
    const ids = loader.snapshot().modes.map((mode) => mode.id);
    expect(ids).toContain("demo");

    await loader.deactivate("ext.demo");
    expect(loader.snapshot().modes.map((mode) => mode.id)).not.toContain("demo");
  });

  it("rejects duplicate ids and dependency violations", async () => {
    const loader = createCapabilityLoader();
    loader.register(builtin);
    expect(() => loader.register(builtin)).toThrow(DuplicatePluginError);

    loader.register({
      id: "ext.dep",
      name: "依赖内置",
      version: "0.1.0",
      dependsOn: ["core.builtin"],
      contributes: { modes: [{ id: "dep", title: "Dep", component: Dummy }] },
    });
    await loader.activateAll();
    expect(() => loader.register({ id: "core.builtin", name: "dup", version: "0.0.1", contributes: {} })).toThrow(DuplicatePluginError);

    // 依赖校验在 register 时即执行：缺失依赖的 manifest 会被拒绝且不残留注册表。
    const missing = createCapabilityLoader();
    expect(() =>
      missing.register({
        id: "ext.orphan",
        name: "孤儿依赖",
        version: "0.1.0",
        dependsOn: ["ext.ghost"],
        contributes: {},
      }),
    ).toThrow(/missing dependency ext\.ghost/);
    expect(missing.snapshot().modes).toHaveLength(0);
  });
});
