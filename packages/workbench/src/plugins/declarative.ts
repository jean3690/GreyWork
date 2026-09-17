import { h, markRaw } from "vue";
import DeclarativePluginView from "./DeclarativePluginView.vue";
import PluginRegionHost from "@/features/plugins/PluginRegionHost.vue";
import type { DeclarativeValue, InstalledPluginPackage } from "./market-types";
import type { PluginManifest, UiRegionContribution } from "./types";
import type { CodePluginRuntime } from "./code-runtime";

/** 安装包 → 工作台清单；页面/区域均由宿主渲染，worker 仅处理 invoke/render 动作。 */
export function adaptInstalledPlugin(pluginPackage: InstalledPluginPackage, runtime?: CodePluginRuntime): PluginManifest {
  const source = pluginPackage.manifest;
  const render = source.runtime?.render;
  const uiRegions: UiRegionContribution[] = [];
  // uiRegion 贡献需要 worker 运行时 + 渲染循环（Rust 已校验）；防呆再查一遍。
  if (runtime && render) {
    for (const region of source.contributes.uiRegions ?? []) {
      uiRegions.push({
        region: region.region,
        id: region.id,
        title: region.title,
        order: region.order,
        overflow: region.overflow,
        component: markRaw({
          name: `DeclarativeRegion_${source.id}_${region.id}`,
          render: () =>
            h(PluginRegionHost, {
              pluginId: source.id,
              regionId: region.id,
              contribution: region,
              render,
              windowDecl: source.window,
              invoke: (handler: string, state: Readonly<Record<string, DeclarativeValue>>) => runtime.invoke(handler, state),
              invokeRaw: (handler: string, state: Readonly<Record<string, DeclarativeValue>>) => runtime.invokeRaw(handler, state),
            }),
        }),
      });
    }
  }
  return {
    id: source.id,
    name: source.name,
    version: source.version,
    description: source.description,
    requires: source.requires,
    contributes: {
      modes: source.contributes.modes.map((mode) => ({
        id: mode.id,
        title: mode.title,
        icon: mode.icon,
        component: markRaw({
          name: `DeclarativePlugin_${source.id}_${mode.id}`,
          render: () =>
            h(DeclarativePluginView, {
              pluginId: source.id,
              modeId: mode.id,
              page: mode.page,
              invoke: runtime
                ? (handler: string, state: Readonly<Record<string, DeclarativeValue>>) => runtime.invoke(handler, state)
                : undefined,
              // 渲染循环声明 + raw 通道（指令集不经 isPatch，校验在渲染循环宿主）。
              render,
              renderChannel: runtime
                ? (handler: string, state: Readonly<Record<string, DeclarativeValue>>) => runtime.invokeRaw(handler, state)
                : undefined,
            }),
        }),
      })),
      uiRegions,
    },
  };
}
