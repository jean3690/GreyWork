export { default as WorkbenchShell } from "./AppShell.vue";
export { createWorkbenchRouter } from "./router/index";
export { capabilitySeam } from "./plugins/loader";
export type { CapabilityLoader } from "./plugins/loader";
export type { PluginManifest, ModeContribution, UiRegionContribution, UiRegionId } from "./plugins/types";
export { i18n, setLocale } from "./i18n";
export type { AppLocale } from "./i18n";
