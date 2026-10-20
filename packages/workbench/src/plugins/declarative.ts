import { h, markRaw } from "vue";
import DeclarativePluginView from "./DeclarativePluginView.vue";
import PluginRegionHost from "@/features/plugins/PluginRegionHost.vue";
import type { DeclarativeValue, InstalledPluginPackage } from "./market-types";
import type { PluginManifest, UiRegionContribution } from "./types";
import type { CodePluginRuntime, PluginPointerEvent } from "./code-runtime";
import { effectiveRegionSchedule } from "./scheduler";
import { isPluginCapabilityGranted } from "./runtime";

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
              // schedule 能力已声明 + 已授权才挂钟（授权门禁由 effectiveRegionSchedule 收敛）。
              schedule: effectiveRegionSchedule(source, (capability) => isPluginCapabilityGranted(source.id, capability)),
              invoke: (handler: string, state: Readonly<Record<string, DeclarativeValue>>) => runtime.invoke(handler, state),
              invokeRaw: (handler: string, state: Readonly<Record<string, DeclarativeValue>>) => runtime.invokeRaw(handler, state),
              // 指针回传通道：仅 render.pointer 声明的包接线（事件归一化/校验在渲染循环宿主）。
              dispatchPointer: render.pointer
                ? (event: PluginPointerEvent, state: Readonly<Record<string, DeclarativeValue>>) => runtime.dispatchPointer(event, state)
                : undefined,
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
              // 指针回传通道：仅 render.pointer 声明的包接线。
              dispatchPointer:
                runtime && render?.pointer
                  ? (event: PluginPointerEvent, state: Readonly<Record<string, DeclarativeValue>>) => runtime.dispatchPointer(event, state)
                  : undefined,
            }),
        }),
      })),
      uiRegions,
    },
  };
}
