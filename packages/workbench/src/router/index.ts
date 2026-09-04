import { createRouter, createWebHashHistory, type Router, type RouteRecordRaw } from "vue-router";
import GuidView from "../views/GuidView.vue";
import ConversationView from "../views/ConversationView.vue";
import AssistantsView from "../views/AssistantsView.vue";
import ScheduledView from "../views/ScheduledView.vue";
import TeamView from "../views/TeamView.vue";
import SettingsView from "../views/SettingsView.vue";

/**
 * GreyWork 外壳路由（hash 模式，兼容 Tauri 桌面端）。
 * 「一比一复刻」路径树：
 *   /guid           全新对话引导页
 *   /conversation/  单 Agent 对话（历史会话）
 *   /assistants     助手库（Agent 设置页的读入口）
 *   /scheduled      定时任务
 *   /team           团队
 *   /settings/*     设置（Agent / 助手 / 外观 / 系统 等子页）
 */
export function createAppRouter(): Router {
  const routes: RouteRecordRaw[] = [
    { path: "/", redirect: "/guid" },
    { path: "/guid", component: GuidView },
    { path: "/conversation/:conversationId?", component: ConversationView },
    { path: "/assistants", component: AssistantsView },
    { path: "/scheduled", component: ScheduledView },
    { path: "/team", component: TeamView },
    { path: "/settings", redirect: "/settings/agent" },
    {
      path: "/settings/:section",
      component: SettingsView,
      props: (route) => ({ section: route.params.section }),
    },
    { path: "/:pathMatch(.*)*", redirect: "/guid" },
  ];

  const router = createRouter({ history: createWebHashHistory(), routes });

  return router;
}
