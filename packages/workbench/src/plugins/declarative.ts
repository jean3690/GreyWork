import { h, markRaw } from "vue";
import DeclarativePluginView from "./DeclarativePluginView.vue";
import PluginRegionHost from "@/features/plugins/PluginRegionHost.vue";
import type { DeclarativeValue, InstalledPluginPackage } from "./market-types";
import type {
  CommandContribution,
  ContextMenuContribution,
  PluginContextTarget,
  PluginManifest,
  StatusBarContribution,
  UiRegionContribution,
} from "./types";
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
  // 命令面板条目：mode 缺省指向该包的第一个页面（Rust 安装期已保证 commands 非空时必有 mode）。
  const firstModeId = source.contributes.modes[0]?.id;
  // 右键条目：目标区域安装期已校验，这里仍按白名单过滤一遍（手工改过 plugin.json 的包）。
  const allowedTargets: readonly PluginContextTarget[] = ["fileTree", "preview", "conversation"];
  const contextMenu: ContextMenuContribution[] = (source.contributes.contextMenu ?? [])
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      targets: entry.targets.filter((target): target is PluginContextTarget => (allowedTargets as readonly string[]).includes(target)),
      modeId: entry.mode ?? firstModeId ?? "",
      pluginId: source.id,
    }))
    .filter((entry) => entry.modeId !== "" && entry.targets.length > 0);
  // 状态栏：与命令同一取舍 —— 条目只负责把用户带到插件页。
  const statusBar: StatusBarContribution[] = (source.contributes.statusBar ?? [])
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      modeId: entry.mode ?? firstModeId ?? "",
      pluginId: source.id,
    }))
    .filter((entry) => entry.modeId !== "");
  const commands: CommandContribution[] = (source.contributes.commands ?? [])
    .map((command) => ({
      id: command.id,
      title: command.title,
      description: command.description,
      modeId: command.mode ?? firstModeId ?? "",
      pluginId: source.id,
    }))
    .filter((command) => command.modeId !== "");
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
      commands,
      contextMenu,
      statusBar,
    },
  };
}
