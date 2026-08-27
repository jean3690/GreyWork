// 验收 #7（单元半）：注册表驱动 —— 追加第 11 个 mock mode 的 manifest 后，
// 无需改 router/index.ts 与任何核心组件，snapshot().modes 即含新项；
// deactivate 后移除，且被依赖时拒绝。
import { describe, expect, it } from "vitest";
import { defineComponent } from "vue";
import { createCapabilityLoader, DependentPluginError, DuplicatePluginError } from "./loader";
import { coreBuiltinManifest } from "./registry";

const Dummy = defineComponent({ render: () => null });

describe("capability loader", () => {
  it("registers default manifest and exposes 6 builtin modes（工作区已并入右栏编辑；3D 空间 / GIS 暂时下线）", async () => {
    const loader = createCapabilityLoader();
    loader.register(coreBuiltinManifest);
    await loader.activateAll();
    const modes = loader.snapshot().modes.map((mode) => mode.id);
    expect(modes).toHaveLength(6);
    expect(modes).toContain("chat");
    expect(modes).not.toContain("overview");
    expect(modes).not.toContain("editor");
    expect(modes).not.toContain("spatial");
    expect(modes).not.toContain("gis");
    expect(loader.snapshot().uiRegions.filter((region) => region.region === "activityPanel")).toHaveLength(7);
    expect(loader.snapshot().uiRegions.filter((region) => region.region === "shellSidebar")).toHaveLength(3);
    // UiRegionId 已移除 projectRail；类型系统保证不再出现该 region。
  });

  it("accepts an 11th plugin mode without touching router or core components", async () => {
    const loader = createCapabilityLoader();
    loader.register(coreBuiltinManifest);
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
    loader.register(coreBuiltinManifest);
    expect(() => loader.register(coreBuiltinManifest)).toThrow(DuplicatePluginError);

    loader.register({
      id: "ext.dep",
      name: "依赖内置",
      version: "0.1.0",
      dependsOn: ["core.builtin"],
      contributes: { modes: [{ id: "dep", title: "Dep", component: Dummy }] },
    });
    await loader.activateAll();
    await expect(loader.deactivate("core.builtin")).rejects.toThrow(DependentPluginError);

    // register 校验：缺依赖直接抛错且不登记
    expect(() =>
      loader.register({
        id: "ext.missing",
        name: "缺依赖",
        version: "0.1.0",
        dependsOn: ["ghost"],
      }),
    ).toThrow(/missing dependency ghost/);
    expect(loader.activeIds()).toHaveLength(2);
  });
});
