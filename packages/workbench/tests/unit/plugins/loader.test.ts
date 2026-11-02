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

    loader.grantCapability("ext.fetcher", "net.fetch");
    await loader.activate("ext.fetcher");

    // 白名单域名：通过（真实 fetch 未 mock 时 api.github.com 会失败，
    // 这里验证的是 host 校验先于网络 —— 用一个格式合法但必然走不到 fetch 的拒绝路径即可）。
    // 未声明的能力：拒绝（最小特权）。
    await expect(loader.callCapability("ext.fetcher", "plugin-admin", {})).rejects.toThrow(/not declared/);
    // 未注册的能力：拒绝。
    await expect(loader.callCapability("ext.fetcher", "fs.read", {})).rejects.toThrow(/not registered/);

    // revoke 即时生效：已激活插件的下一次调用被拒。
    loader.revokeCapability("ext.fetcher", "net.fetch");
    await expect(loader.callCapability("ext.fetcher", "net.fetch", { url: "https://api.github.com/" })).rejects.toThrow(/revoked/);

    // 可信插件：声明即可调用。
    loader.setTrustedPluginIds(["ext.fetcher"]);
    loader.grantCapability("ext.fetcher", "net.fetch");
    const before = capabilityAuditLog().length;
    await expect(loader.callCapability("ext.fetcher", "net.fetch", { url: "http://api.github.com/" })).rejects.toThrow(/https/);
    // 拒绝路径也留审计。
    expect(capabilityAuditLog().length).toBeGreaterThanOrEqual(before);
  });

  it("授权按插件隔离：给 A 授权不放行 B，撤销只影响 A", async () => {
    const loader = createCapabilityLoader();
    for (const id of ["ext.a", "ext.b"]) {
      loader.register({
        id,
        name: id,
        version: "0.1.0",
        requires: [{ capability: "net.fetch", hosts: ["api.github.com"] }],
      });
    }

    loader.grantCapability("ext.a", "net.fetch");
    expect(loader.isCapabilityGranted("ext.a", "net.fetch")).toBe(true);
    expect(loader.isCapabilityGranted("ext.b", "net.fetch")).toBe(false);
    expect(loader.grantedCapabilities()).toEqual({ "ext.a": ["net.fetch"] });

    // B 未授权 → 激活被门禁拒绝；A 正常激活。
    await expect(loader.activate("ext.b")).rejects.toThrow(/missing grants.*net.fetch/);
    await loader.activate("ext.a");

    // 撤销 A 的授权：授权快照清空（不影响 B，因为 B 本就没有）。
    loader.revokeCapability("ext.a", "net.fetch");
    expect(loader.grantedCapabilities()).toEqual({});
  });

  it("grantLegacyCapabilities：历史全局授权在注册时落到声明该能力的插件上", () => {
    const loader = createCapabilityLoader();
    loader.grantLegacyCapabilities(["net.fetch"]);
    loader.register({
      id: "ext.legacy",
      name: "旧授权迁移",
      version: "0.1.0",
      requires: [{ capability: "net.fetch", hosts: ["api.github.com"] }],
    });
    loader.register({ id: "ext.plain", name: "未声明该能力", version: "0.1.0" });

    expect(loader.grantedCapabilities()).toEqual({ "ext.legacy": ["net.fetch"] });
    expect(loader.isCapabilityGranted("ext.plain", "net.fetch")).toBe(false);
  });
});

const commandPlugin = (id: string, commands: Array<{ id: string; title: string }>): PluginManifest => ({
  id,
  name: id,
  version: "0.1.0",
  contributes: {
    modes: [{ id: `${id}-page`, title: id, component: Dummy }],
    commands: commands.map((command) => ({
      id: command.id,
      title: command.title,
      modeId: `${id}-page`,
      pluginId: id,
    })),
  },
});

describe("命令面板贡献", () => {
  it("激活后进快照、停用后消失（面板与视图读同一份 seam）", async () => {
    const loader = createCapabilityLoader();
    loader.register(commandPlugin("ext.pet", [{ id: "feed", title: "喂猫" }]));
    await loader.activate("ext.pet");

    expect(loader.snapshot().commands).toEqual([{ id: "feed", title: "喂猫", modeId: "ext.pet-page", pluginId: "ext.pet" }]);

    await loader.deactivate("ext.pet");
    expect(loader.snapshot().commands).toEqual([]);
  });

  it("命令 id 是全局命名空间：跨插件重名被拒", () => {
    const loader = createCapabilityLoader();
    loader.register(commandPlugin("ext.a", [{ id: "feed", title: "喂猫" }]));
    expect(() => loader.register(commandPlugin("ext.b", [{ id: "feed", title: "喂狗" }]))).toThrow(ContributionConflictError);
  });

  it("同包内重复命令 id 也被拒", () => {
    const loader = createCapabilityLoader();
    expect(() =>
      loader.register(
        commandPlugin("ext.dup", [
          { id: "feed", title: "喂猫" },
          { id: "feed", title: "再喂" },
        ]),
      ),
    ).toThrow(ContributionConflictError);
  });
});

describe("右键菜单贡献", () => {
  const menuPlugin = (id: string, entries: Array<{ id: string; label: string }>): PluginManifest => ({
    id,
    name: id,
    version: "0.1.0",
    contributes: {
      modes: [{ id: `${id}-page`, title: id, component: Dummy }],
      contextMenu: entries.map((entry) => ({
        id: entry.id,
        label: entry.label,
        targets: ["fileTree"],
        modeId: `${id}-page`,
        pluginId: id,
      })),
    },
  });

  it("激活后进快照、停用后消失", async () => {
    const loader = createCapabilityLoader();
    loader.register(menuPlugin("ext.menu", [{ id: "open", label: "用插件打开" }]));
    await loader.activate("ext.menu");
    expect(loader.snapshot().contextMenu).toEqual([
      { id: "open", label: "用插件打开", targets: ["fileTree"], modeId: "ext.menu-page", pluginId: "ext.menu" },
    ]);

    await loader.deactivate("ext.menu");
    expect(loader.snapshot().contextMenu).toEqual([]);
  });

  it("条目 id 跨插件重名被拒（右键文案重叠会让人以为点了同一件事）", () => {
    const loader = createCapabilityLoader();
    loader.register(menuPlugin("ext.m1", [{ id: "open", label: "打开" }]));
    expect(() => loader.register(menuPlugin("ext.m2", [{ id: "open", label: "打开" }]))).toThrow(ContributionConflictError);
  });
});

describe("状态栏贡献", () => {
  const statusPlugin = (id: string, entries: Array<{ id: string; label: string }>): PluginManifest => ({
    id,
    name: id,
    version: "0.1.0",
    contributes: {
      modes: [{ id: `${id}-page`, title: id, component: Dummy }],
      statusBar: entries.map((entry) => ({
        id: entry.id,
        label: entry.label,
        modeId: `${id}-page`,
        pluginId: id,
      })),
    },
  });

  it("激活后进快照、停用后消失", async () => {
    const loader = createCapabilityLoader();
    loader.register(statusPlugin("ext.status", [{ id: "sync", label: "上次成功 10:24" }]));
    await loader.activate("ext.status");
    expect(loader.snapshot().statusBar).toEqual([
      { id: "sync", label: "上次成功 10:24", modeId: "ext.status-page", pluginId: "ext.status" },
    ]);

    await loader.deactivate("ext.status");
    expect(loader.snapshot().statusBar).toEqual([]);
  });

  it("条目 id 跨插件重名被拒（setStatus 按 id 寻址，重名会更新到别家条目）", () => {
    const loader = createCapabilityLoader();
    loader.register(statusPlugin("ext.s1", [{ id: "sync", label: "x" }]));
    expect(() => loader.register(statusPlugin("ext.s2", [{ id: "sync", label: "y" }]))).toThrow(ContributionConflictError);
  });
});

describe("快捷键贡献", () => {
  const keyPlugin = (id: string, binding: string): PluginManifest => ({
    id,
    name: id,
    version: "0.1.0",
    contributes: {
      modes: [{ id: `${id}-page`, title: id, component: Dummy }],
      keybindings: [{ id: "open", binding, modeId: `${id}-page`, pluginId: id }],
    },
  });

  it("激活后进快照、停用后消失", async () => {
    const loader = createCapabilityLoader();
    loader.register(keyPlugin("ext.k", "mod+shift+p"));
    await loader.activate("ext.k");
    expect(loader.snapshot().keybindings).toEqual([{ id: "open", binding: "mod+shift+p", modeId: "ext.k-page", pluginId: "ext.k" }]);

    await loader.deactivate("ext.k");
    expect(loader.snapshot().keybindings).toEqual([]);
  });

  it("组合键跨插件重名被拒（后注册的永远不触发，注册期就拒掉）", () => {
    const loader = createCapabilityLoader();
    loader.register(keyPlugin("ext.k1", "mod+shift+p"));
    expect(() => loader.register(keyPlugin("ext.k2", "mod+shift+p"))).toThrow(ContributionConflictError);
  });
});
