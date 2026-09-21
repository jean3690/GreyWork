import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCapabilityLoader } from "@/plugins/loader";
import { BUILTIN_PLUGINS } from "@/plugins/builtin";
import {
  capabilityGrants,
  grantPluginCapability,
  isPluginCapabilityGranted,
  isPluginEnabled,
  pluginActive,
  pluginManifests,
  registerPlugin,
  resetPluginRuntime,
  revokePluginCapability,
  setPluginEnabled,
} from "@/plugins/runtime";
import { setCapabilityLoaderForTest } from "@/plugins/current";
import type { PluginManifest } from "@/plugins/types";

/**
 * 插件运行时的启停语义：boot 注册内置并按存档激活；enable/disable 即时生效并落盘；
 * 换 loader 重放 boot 时按存档还原。loader 的依赖拓扑错误（DependentPluginError 等）
 * 由 loader 单测覆盖，这里只测 runtime 层。
 */
const storageHolder = globalThis as { localStorage?: Storage };

function injectStorage(): void {
  const backing: Record<string, string> = {};
  storageHolder.localStorage = {
    getItem: (key: string) => backing[key] ?? null,
    setItem: (key: string, value: string) => {
      backing[key] = value;
    },
    removeItem: (key: string) => {
      delete backing[key];
    },
    clear: () => {
      for (const key of Object.keys(backing)) delete backing[key];
    },
    key: (index: number) => Object.keys(backing)[index] ?? null,
    get length() {
      return Object.keys(backing).length;
    },
  } as Storage;
}

beforeEach(() => {
  injectStorage();
  // 每个用例一套全新 loader + runtime 状态，互不串扰
  setCapabilityLoaderForTest(createCapabilityLoader());
  resetPluginRuntime();
});

afterEach(() => {
  setCapabilityLoaderForTest(null);
  resetPluginRuntime();
  delete storageHolder.localStorage;
});

async function boot(): Promise<void> {
  const { bootPlugins } = await import("@/plugins/runtime");
  await bootPlugins();
}

describe("bootPlugins", () => {
  it("首次启动：注册全部内置清单并默认激活（无存档 = 全开）", async () => {
    await boot();
    expect(pluginManifests.value.map((m) => m.id)).toEqual(BUILTIN_PLUGINS.map((m) => m.id));
    expect(pluginActive.value).toEqual(BUILTIN_PLUGINS.map((m) => m.id));
    expect(isPluginEnabled("core.plugins")).toBe(true);
  });

  it("幂等：二次 boot 不重复注册、不改变活跃集", async () => {
    await boot();
    await boot();
    expect(pluginManifests.value).toHaveLength(BUILTIN_PLUGINS.length);
    expect(pluginActive.value).toEqual(BUILTIN_PLUGINS.map((m) => m.id));
  });
});

describe("启停与持久化", () => {
  it("disable 即时停用并落盘；换 loader 重放时按存档还原（空存档仍默认全开）", async () => {
    await boot();
    // 全关：逐个停用全部内置（新增内置后不能只停 core.plugins 就断言 []）
    for (const manifest of BUILTIN_PLUGINS) {
      await setPluginEnabled(manifest.id, false);
    }
    expect(pluginActive.value).toEqual([]);
    expect(storageHolder.localStorage?.getItem("greywork.plugins.enabled")).toBe("[]");

    // 新会话：新 loader + 清 runtime，存档 = 全关 → boot 后不激活
    setCapabilityLoaderForTest(createCapabilityLoader());
    resetPluginRuntime();
    await boot();
    expect(pluginActive.value).toEqual([]);
    expect(isPluginEnabled("core.plugins")).toBe(false);
  });

  it("enable 把停用的插件拉回活跃并更新存档", async () => {
    await boot();
    for (const manifest of BUILTIN_PLUGINS) {
      await setPluginEnabled(manifest.id, false);
    }
    await setPluginEnabled("core.plugins", true);
    expect(isPluginEnabled("core.plugins")).toBe(true);
    expect(pluginActive.value).toEqual(["core.plugins"]);
  });

  it("老存档不自动启用后加的内置插件（无迁移：存档是完整活跃集，[] 是全关的事实）", async () => {
    // 模拟 core.artifacts 上线前的老用户：存档里只有 core.plugins
    storageHolder.localStorage?.setItem("greywork.plugins.enabled", JSON.stringify(["core.plugins"]));
    await boot();
    expect(pluginActive.value).toEqual(["core.plugins"]);
    expect(isPluginEnabled("core.artifacts")).toBe(false);
    // 存回的还是原样，没被 boot 偷偷改掉
    expect(storageHolder.localStorage?.getItem("greywork.plugins.enabled")).toBe('["core.plugins"]');
  });
});

describe("能力授权与持久化", () => {
  it("第三方插件未授权时拒绝激活，按插件授权后可激活（不波及其它插件）", async () => {
    await boot();
    registerPlugin({ id: "ext.secure", name: "需授权插件", version: "1.0.0", requires: ["workspace:write"] });

    await expect(setPluginEnabled("ext.secure", true)).rejects.toThrow(/missing grants.*workspace:write/);
    expect(isPluginEnabled("ext.secure")).toBe(false);

    grantPluginCapability("ext.secure", "workspace:write");
    expect(isPluginCapabilityGranted("ext.secure", "workspace:write")).toBe(true);
    // 授权按插件隔离：另一个插件不受影响。
    expect(isPluginCapabilityGranted("ext.other", "workspace:write")).toBe(false);
    expect(storageHolder.localStorage?.getItem("greywork.plugins.capabilityGrants.v2")).toBe('{"ext.secure":["workspace:write"]}');
    await setPluginEnabled("ext.secure", true);
    expect(isPluginEnabled("ext.secure")).toBe(true);
  });

  it("boot 重放按插件授权；撤销授权不强停活跃插件，但阻止其下次激活", async () => {
    storageHolder.localStorage?.setItem("greywork.plugins.capabilityGrants.v2", JSON.stringify({ "ext.secure": ["workspace:write"] }));
    await boot();
    expect(capabilityGrants.value).toEqual({ "ext.secure": ["workspace:write"] });

    registerPlugin({ id: "ext.secure", name: "需授权插件", version: "1.0.0", requires: ["workspace:write"] });
    await setPluginEnabled("ext.secure", true);
    revokePluginCapability("ext.secure", "workspace:write");
    expect(isPluginEnabled("ext.secure")).toBe(true);
    await setPluginEnabled("ext.secure", false);
    await expect(setPluginEnabled("ext.secure", true)).rejects.toThrow(/missing grants/);
  });

  it("v1 全局白名单迁移：落到声明该能力的插件上，写回 v2 并清掉 v1 键", async () => {
    storageHolder.localStorage?.setItem("greywork.plugins.capabilityGrants", JSON.stringify(["workspace:write"]));
    await boot();

    // 内置插件不声明该能力 → 无迁移项；v1 键应被清掉。
    expect(storageHolder.localStorage?.getItem("greywork.plugins.capabilityGrants")).toBeNull();
    expect(capabilityGrants.value).toEqual({});

    // 迁移期之后注册的插件（市场包）：历史全局授权落到它身上并持久化。
    registerPlugin({ id: "ext.secure", name: "需授权插件", version: "1.0.0", requires: ["workspace:write"] });
    expect(isPluginCapabilityGranted("ext.secure", "workspace:write")).toBe(true);
    expect(storageHolder.localStorage?.getItem("greywork.plugins.capabilityGrants.v2")).toBe('{"ext.secure":["workspace:write"]}');
    // 直接激活即可（迁移已补授权）。
    await setPluginEnabled("ext.secure", true);
    expect(isPluginEnabled("ext.secure")).toBe(true);
  });
});

describe("运行期注册", () => {
  it("registerPlugin 追加第三方清单，enable 后计入活跃集", async () => {
    await boot();
    const thirdParty: PluginManifest = {
      id: "ext.demo",
      name: "演示插件",
      version: "1.0.0",
      contributes: { modes: [{ id: "demo", title: "演示", component: { render: () => null } }] },
    };
    registerPlugin(thirdParty);
    expect(pluginManifests.value.some((m) => m.id === "ext.demo")).toBe(true);

    await setPluginEnabled("ext.demo", true);
    expect(pluginActive.value).toContain("ext.demo");
    // 停掉内置再验证拓扑无关的普通开关
    await setPluginEnabled("ext.demo", false);
    expect(isPluginEnabled("ext.demo")).toBe(false);
  });
});
