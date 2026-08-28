// 两套插件系统的桥接层：
// @greywork/plugins 的 PluginStore 管理 manifest 安装/卸载（纯数据），
// workbench 的 CapabilityLoader(capabilitySeam) 管理 UI contributions（modes/uiRegions）。
// 本模块把「已安装的市场插件」适配为「能力注册表清单」，使安装/卸载产生可见 UI 变化。
import { defineAsyncComponent, type Component } from "vue";
import type { PluginManifest as MarketManifest, PluginStore } from "@greywork/plugins";
import type { ModeContribution, PluginManifest as SeamManifest, UiRegionContribution } from "./types";
import { capabilitySeam, type CapabilityLoader } from "./loader";

/** 插件声明的视图能力 id → 内置 Vue 组件（插件包本身不含组件，由 workbench 解析）。 */
const VIEW_COMPONENTS: Record<string, () => Promise<Component>> = {
  chat: () => import("../views/ChatView.vue"),
  agents: () => import("../views/AgentsView.vue"),
  analytics: () => import("../views/AnalyticsView.vue"),
  market: () => import("../views/MarketView.vue"),
  automation: () => import("../views/AutomationView.vue"),
  settings: () => import("../views/SettingsView.vue"),
  gis: () => import("../views/GisView.vue"),
  spatial: () => import("../views/SpatialView.vue"),
};

/** 插件声明的面板能力 id → 内置 Vue 组件（键与 uiRegion id 一致，如 "activity.terminal"）。 */
const PANEL_COMPONENTS: Record<string, () => Promise<Component>> = {
  "activity.editor": () => import("../components/panels/EditorPane.vue"),
  "activity.diffs": () => import("../components/panels/DiffsPane.vue"),
  "activity.web": () => import("../components/panels/WebPreviewPane.vue"),
  "activity.terminal": () => import("../components/panels/TerminalPane.vue"),
  "activity.artifacts": () => import("../components/panels/ArtifactsPane.vue"),
  "activity.review": () => import("../components/panels/ReviewPane.vue"),
  "activity.sources": () => import("../components/panels/SourcesPane.vue"),
};

/** 市场插件 manifest → 能力注册表 manifest；无法产生任何贡献时返回 null。 */
export function seamifyMarketManifest(market: MarketManifest): SeamManifest | null {
  if (market.kind === "extension" && market.type === "ui") {
    const modes: ModeContribution[] = [];
    const uiRegions: UiRegionContribution[] = [];
    for (const view of market.contributes?.views ?? []) {
      const load = VIEW_COMPONENTS[view];
      if (!load) continue;
      modes.push({
        id: `ext:${market.id}:${view}`,
        title: `${market.name} · ${view}`,
        component: defineAsyncComponent(load),
      });
    }
    for (const panel of market.contributes?.panels ?? []) {
      const load = PANEL_COMPONENTS[panel];
      if (!load) continue;
      uiRegions.push({
        region: "activityPanel",
        id: `ext:${market.id}:${panel}`,
        title: `${market.name} · ${panel}`,
        component: defineAsyncComponent(load),
        order: 100,
      });
    }
    if (modes.length === 0 && uiRegions.length === 0) {
      return { id: market.id, name: market.name, version: market.version, contributes: { capabilities: [`extension:${market.id}`] } };
    }
    return { id: market.id, name: market.name, version: market.version, contributes: { modes, uiRegions } };
  }
  // skill / mcp-server / 非 ui extension：仅登记能力字符串，不产生 UI 贡献。
  return { id: market.id, name: market.name, version: market.version, contributes: { capabilities: [`${market.kind}:${market.id}`] } };
}

/**
 * 全量 diff 同步：已安装插件 → 注册/激活；已卸载（且非内置）→ 去激活。
 * loader 可注入独立实例便于测试；缺省同步全局 capabilitySeam。
 */
export async function syncMarketToCapabilities(market: PluginStore, loader: CapabilityLoader = capabilitySeam): Promise<void> {
  const installed = new Set(market.installedIds());
  for (const id of loader.activeIds()) {
    if (id !== "core.builtin" && !installed.has(id)) {
      await loader.deactivate(id).catch(() => undefined);
    }
  }
  for (const manifest of market.listInstalled()) {
    const seam = seamifyMarketManifest(manifest);
    if (!seam) continue;
    if (!loader.activeIds().includes(seam.id)) {
      try {
        loader.register(seam);
      } catch {
        // DuplicatePluginError：同一插件已注册（此前仅被去激活），恢复激活即可。
      }
      await loader.activate(seam.id);
    }
  }
}
