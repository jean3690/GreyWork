/**
 * 插件宿主：模式页（/plugin/:modeId）与悬浮窗内容（/plugin-window）。
 *
 * **本特性的 `setup` 拥有 `bootPlugins()`**：它注册内置插件清单并激活（幂等），
 * 插件贡献的 modes 与 UI 区域都靠它出现。前端不启用本特性 ⇒ 不启动插件运行时，
 * 于是「没有插件中心」不会表现为「插件中心空着」，而是压根没有这个特性。
 *
 * 注意 `/plugin-window` 带 `meta.bare`：悬浮窗是透明置顶小窗，Shell 见了这个标记
 * 只渲染 router-view、不出任何外壳 chrome。
 */
import type { Feature } from "@/front/types";
import { bootPlugins } from "@/plugins/runtime";

export const pluginsFeature: Feature = {
  id: "plugins",
  routes: [
    { path: "/plugin/:modeId", component: () => import("@/features/plugins/PluginView.vue") },
    { path: "/plugin-window", component: () => import("@/features/plugins/PluginWindowView.vue"), meta: { bare: true } },
  ],
  setup: () => bootPlugins(),
};
