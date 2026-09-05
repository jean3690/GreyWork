import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCapabilityLoader } from "@/plugins/loader";
import { BUILTIN_PLUGINS } from "@/plugins/builtin";
import { isPluginEnabled, pluginActive, pluginManifests, registerPlugin, resetPluginRuntime, setPluginEnabled } from "@/plugins/runtime";
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
    await setPluginEnabled("core.plugins", false);
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
    await setPluginEnabled("core.plugins", false);
    await setPluginEnabled("core.plugins", true);
    expect(isPluginEnabled("core.plugins")).toBe(true);
    expect(pluginActive.value).toEqual(["core.plugins"]);
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
