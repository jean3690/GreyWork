export { default as WorkbenchShell } from "./AppShell.vue";
export { createWorkbenchRouter } from "./router/index";
export { capabilitySeam } from "./plugins/loader";
export type { CapabilityLoader } from "./plugins/loader";
export type { PluginManifest, ModeContribution, UiRegionContribution, UiRegionId } from "./plugins/types";
export { i18n, setLocale } from "./i18n";
export type { AppLocale } from "./i18n";
// 测试/调试钩子（dev-only 由调用方按 import.meta.env.DEV 守卫）：暴露内存文件
// 系统与事件总线，便于 e2e 注入产物并触发预览，不进生产构建。
export { workspaceFs } from "./stores/vfs";
export { appEvents } from "./events";
