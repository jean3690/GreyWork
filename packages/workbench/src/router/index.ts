import { createRouter, createWebHashHistory, type Router, type RouteRecordRaw } from "vue-router";

/**
 * GreyWork 外壳路由（hash 模式，兼容 Tauri 桌面端）。
 * 「一比一复刻」路径树：
 *   /guid           全新对话引导页
 *   /conversation/  单 Agent 对话（历史会话）
 *   /assistants     助手库（Agent 设置页的读入口）
 *   /scheduled      定时任务
 *   /team           团队
 *   /settings/*     设置（Agent / 助手 / 外观 / 系统 等子页）
 *   /plugin/:modeId 插件贡献的模式页（组件取自 seam 的 modes 快照，无需注册路由）
 *
 * 视图全部懒加载：ConversationView 的对话 store 链会把 ExcelJS / pptxgenjs /
 * jszip 焊进出入口 chunk，让从不产表格/幻灯的用户在开屏就解析这几百 KB 写入器。
 */
export function createAppRouter(): Router {
  const routes: RouteRecordRaw[] = [
    { path: "/", redirect: "/guid" },
    { path: "/guid", component: () => import("../views/GuidView.vue") },
    { path: "/conversation/:conversationId?", component: () => import("../views/ConversationView.vue") },
    { path: "/assistants", component: () => import("../views/AssistantsView.vue") },
    { path: "/scheduled", component: () => import("../views/ScheduledView.vue") },
    { path: "/team", component: () => import("../views/TeamView.vue") },
    { path: "/plugin/:modeId", component: () => import("../views/PluginView.vue") },
    { path: "/settings", redirect: "/settings/agent" },
    {
      path: "/settings/:section",
      component: () => import("../views/SettingsView.vue"),
      props: (route) => ({ section: route.params.section }),
    },
    { path: "/:pathMatch(.*)*", redirect: "/guid" },
  ];

  const router = createRouter({ history: createWebHashHistory(), routes });

  return router;
}
