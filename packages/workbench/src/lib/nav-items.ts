/**
 * 侧栏导航清单的唯一来源：内置快捷入口 + 插件贡献的 modes。
 * Sider 与标题栏搜索都读这里，避免「侧栏有一个入口、搜索却搜不到」的漂移。
 */
export interface NavItem {
  path: string;
  label: string;
  icon: string;
}

/** 内置快捷入口（非插件）。 */
export const BUILTIN_NAV_ITEMS: readonly NavItem[] = [
  { path: "/assistants", label: "远程助手", icon: "robot" },
  { path: "/scheduled", label: "定时任务", icon: "alarm-clock" },
  { path: "/team", label: "团队", icon: "peoples" },
];

/** 插件 modes → 导航项（点击走 /plugin/:id 由 PluginView 宿主渲染）。 */
export function pluginNavItems(modes: readonly { id: string; title: string; icon?: string | null }[]): NavItem[] {
  return modes.map((mode) => ({ path: `/plugin/${mode.id}`, label: mode.title, icon: mode.icon ?? "magic" }));
}

/** 完整导航清单：内置在前，插件在后。 */
export function buildNavItems(modes: readonly { id: string; title: string; icon?: string | null }[]): NavItem[] {
  return [...BUILTIN_NAV_ITEMS, ...pluginNavItems(modes)];
}
