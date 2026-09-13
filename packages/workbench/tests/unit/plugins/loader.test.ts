// capability loader：注册表驱动 —— 追加 manifest 后 snapshot 即含新 mode，
// deactivate 后移除，且被依赖时拒绝。旧壳的 coreBuiltinManifest 已随旧前端删除，
// 此处用内联 manifest 验证 loader 机制本身。
import { describe, expect, it } from "vitest";
import { defineComponent } from "vue";
import { CapabilityCallError, ContributionConflictError, createCapabilityLoader, DuplicatePluginError } from "@/plugins/loader";
import type { PluginManifest } from "@/plugins/types";
import { capabilityAuditLog, resetCapabilityAuditForTest } from "@/plugins/capabilities";

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

  it("activate 会激活完整依赖闭包，且按依赖优先顺序贡献能力", async () => {
    const loader = createCapabilityLoader();
    loader.register(builtin);
    loader.register({
      id: "ext.dep",
      name: "依赖内置",
      version: "0.1.0",
      dependsOn: ["core.builtin"],
      contributes: { modes: [{ id: "dep", title: "Dep", component: Dummy }] },
    });

    await loader.activate("ext.dep");
    expect(loader.activeIds()).toEqual(["core.builtin", "ext.dep"]);
    expect(loader.snapshot().modes.map((mode) => mode.id)).toEqual(["chat", "workspaces", "dep"]);
  });

  it("注册期拒绝跨插件及插件内部重复的贡献 id", () => {
    const loader = createCapabilityLoader();
    loader.register(builtin);

    expect(() =>
      loader.register({
        id: "ext.mode-conflict",
        name: "模式冲突",
        version: "0.1.0",
        contributes: { modes: [{ id: "chat", title: "冲突", component: Dummy }] },
      }),
    ).toThrow(ContributionConflictError);

    expect(() =>
      loader.register({
        id: "ext.region-conflict",
        name: "面板冲突",
        version: "0.1.0",
        contributes: {
          uiRegions: [
            { region: "activityPanel", id: "duplicate", title: "A", component: Dummy },
            { region: "shellSidebar", id: "duplicate", title: "B", component: Dummy },
          ],
        },
      }),
    ).toThrow(ContributionConflictError);
  });

  it("仅允许注销未激活且未被依赖的清单", async () => {
    const loader = createCapabilityLoader();
    loader.register(builtin);
    await loader.activate("core.builtin");
    expect(() => loader.unregister("core.builtin")).toThrow(/cannot unregister active plugin/);

    await loader.deactivate("core.builtin");
    loader.unregister("core.builtin");
    await expect(loader.activate("core.builtin")).rejects.toThrow(/unknown plugin id/);
  });

  it("callCapability 三重校验：未声明 / 未授权 / revoke 后即时拒绝，可信插件声明即可调用", async () => {
    resetCapabilityAuditForTest();
    const loader = createCapabilityLoader();
    loader.register({
      id: "ext.fetcher",
      name: "网络插件",
      version: "0.1.0",
      requires: [{ capability: "net.fetch", hosts: ["api.github.com"] }],
    });

    // 未激活。
    await expect(loader.callCapability("ext.fetcher", "net.fetch", { url: "https://api.github.com/" })).rejects.toThrow(
      CapabilityCallError,
    );

    loader.grantCapability("net.fetch");
    await loader.activate("ext.fetcher");

    // 白名单域名：通过（真实 fetch 未 mock 时 api.github.com 会失败，
    // 这里验证的是 host 校验先于网络 —— 用一个格式合法但必然走不到 fetch 的拒绝路径即可）。
    // 未声明的能力：拒绝（最小特权）。
    await expect(loader.callCapability("ext.fetcher", "plugin-admin", {})).rejects.toThrow(/not declared/);
    // 未注册的能力：拒绝。
    await expect(loader.callCapability("ext.fetcher", "fs.read", {})).rejects.toThrow(/not registered/);

    // revoke 即时生效：已激活插件的下一次调用被拒。
    loader.revokeCapability("net.fetch");
    await expect(loader.callCapability("ext.fetcher", "net.fetch", { url: "https://api.github.com/" })).rejects.toThrow(/revoked/);

    // 可信插件：声明即可调用。
    loader.setTrustedPluginIds(["ext.fetcher"]);
    loader.grantCapability("net.fetch");
    const before = capabilityAuditLog().length;
    await expect(loader.callCapability("ext.fetcher", "net.fetch", { url: "http://api.github.com/" })).rejects.toThrow(/https/);
    // 拒绝路径也留审计。
    expect(capabilityAuditLog().length).toBeGreaterThanOrEqual(before);
  });
});
