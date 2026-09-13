import { defineAsyncComponent } from "vue";
import type { PluginManifest } from "@greywork/workbench";

/**
 * 宿主侧第三方插件示例：只依赖工作台公开接口，不修改工作台路由或内置清单。
 * 默认仅注册、不激活；用户在插件中心授权并启用后才进入能力快照。
 */
export const DEMO_PLUGIN: PluginManifest = {
  id: "demo.counter",
  name: "Demo 计数器",
  version: "1.0.0",
  description: "验证第三方插件注册、能力授权、动态页面挂载与停用清理。",
  requires: ["demo:run"],
  contributes: {
    modes: [
      {
        id: "demo-counter",
        title: "Demo",
        icon: "lightning",
        component: defineAsyncComponent(() => import("./DemoPluginView.vue")),
      },
    ],
    capabilities: ["demo-counter:view"],
  },
};
