// 外壳为唯一前端。旧工作台（WorkbenchShell / createWorkbenchRouter 及其视图、
// 组件、registry、pluginMarket）已删除；此处只导出外壳、能力缝、i18n 与 e2e 调试钩子。
export { default as Shell } from "./Shell.vue";
export { createAppRouter } from "./router";
export { ICONS, getIconShapes, iconNames } from "./lib/icons";
export type { IconShape } from "./lib/icons";
export { capabilitySeam } from "./plugins/loader";
export type { CapabilityLoader } from "./plugins/loader";
export type { PluginManifest, ModeContribution, UiRegionContribution, UiRegionId } from "./plugins/types";
// 插件宿主 API：外部 host 可在 Shell 挂载前 registerPlugin / 换 loader。
export {
  bootPlugins,
  registerPlugin,
  setPluginEnabled,
  isPluginEnabled,
  unregisterPlugin,
  grantPluginCapability,
  revokePluginCapability,
  isPluginCapabilityGranted,
  restoreBuiltinPlugins,
} from "./plugins/runtime";
export { bootInstalledMarketPlugins } from "./plugins/market";
// 桌面宿主（拖放打开等）需要的状态入口。
export { usePreviewStore } from "./stores/preview";
// 输入卡附件拖放区判定：App.vue 的全局拖放要先剔除落在输入卡上的那次。
export { DROPZONE_ATTR, isPhysicalPointInDropzone } from "./lib/use-attachments";
export { setCapabilityLoaderForTest, useCapabilityLoader } from "./plugins/current";
export { i18n, setLocale } from "./i18n";
export type { AppLocale } from "./i18n";
// 测试/调试钩子（dev-only 由调用方按 import.meta.env.DEV 守卫）：暴露内存文件
// 系统与事件总线，便于 e2e 注入产物并触发预览，不进生产构建。
export { workspaceFs } from "./stores/vfs";
export { appEvents } from "./events";
