import { defineAsyncComponent } from "vue";
import type { PluginManifest } from "./types";

/**
 * 内置插件清单：随外壳 bootstrap 注册并默认激活。
 *
 * 贡献组件用 defineAsyncComponent 懒加载 —— 内置插件页不该因为「注册在常驻模块里」
 * 就把组件焊进启动链；清单本身只是几行元数据。
 */
export const BUILTIN_PLUGINS: PluginManifest[] = [
  {
    id: "core.plugins",
    name: "插件中心",
    version: "0.1.0",
    description: "查看已注册插件与它们贡献的能力，启停任意插件。插件中心自身也是一个插件 —— 把它停掉即回到未接插件时的外壳。",
    contributes: {
      modes: [
        {
          id: "plugins",
          title: "市场",
          icon: "magic",
          component: defineAsyncComponent(() => import("@/features/plugins/PluginsView.vue")),
        },
      ],
      capabilities: ["plugin-admin"],
    },
  },
  {
    id: "core.artifacts",
    name: "产物面板",
    version: "0.1.0",
    description: "底部活动面板（activityPanel）的「产物」页签：汇总会话中生成的全部产物，点击即右栏预览。启用后标题栏出现活动面板开关。",
    contributes: {
      uiRegions: [
        {
          region: "activityPanel",
          id: "activity.artifacts",
          title: "产物",
          order: 0,
          component: defineAsyncComponent(() => import("@/features/activity/ArtifactsPanel.vue")),
        },
      ],
    },
  },
];
