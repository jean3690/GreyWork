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
          title: "插件",
          icon: "magic",
          component: defineAsyncComponent(() => import("../views/PluginsView.vue")),
        },
      ],
      capabilities: ["plugin-admin"],
    },
  },
];
