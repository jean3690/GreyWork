/**
 * 侧栏导航清单的唯一来源：当前前端启用特性贡献的入口 + 插件贡献的 modes。
 * Sider / MinimalSider 与标题栏搜索都读这里，避免「侧栏有一个入口、搜索却搜不到」的漂移。
 *
 * 内置入口不再写死在本文件 —— 它们由各 feature 的 `spec.ts` 自带（见 `front/types.ts`）。
 * 于是「这个前端有没有团队页」与「侧栏有没有团队入口」是同一处声明，不可能对不上；
 * 而拆前端时，从特性集里去掉一项就等于路由与入口一起消失。
 */
import { currentFront } from "@/front/current";
import type { FrontSpec, NavItem } from "@/front/types";

export type { NavItem };

/** 当前前端启用特性贡献的快捷入口（非插件）。顺序即特性声明顺序。 */
export function builtinNavItems(front: FrontSpec = currentFront()): NavItem[] {
  return front.features.flatMap((feature) => feature.nav ?? []);
}

/** 插件 modes → 导航项（点击走 /plugin/:id 由 PluginView 宿主渲染）。 */
export function pluginNavItems(modes: readonly { id: string; title: string; icon?: string | null }[]): NavItem[] {
  return modes.map((mode) => ({ path: `/plugin/${mode.id}`, label: mode.title, icon: mode.icon ?? "magic" }));
}

/** 完整导航清单：前端贡献的入口在前，插件 modes 在后。 */
export function buildNavItems(
  modes: readonly { id: string; title: string; icon?: string | null }[],
  front: FrontSpec = currentFront(),
): NavItem[] {
  return [...builtinNavItems(front), ...pluginNavItems(modes)];
}
