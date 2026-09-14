import { createRouter, createWebHashHistory, type Router, type RouteRecordRaw } from "vue-router";

/**
 * GreyWork 外壳路由（hash 模式，兼容 Tauri 桌面端）。
 * 「一比一复刻」路径树：
 *   /guid           全新对话引导页
 *   /conversation/  单 Agent 对话（历史会话）
 *   /assistants     助手库（Agent 设置页的读入口）
 *   /scheduled      定时任务
 *   /team           团队
 *   /plugin/:modeId 插件贡献的模式页（组件取自 seam 的 modes 快照，无需注册路由）
 *
 * 设置不是路由：它是 Shell 持有的弹窗（components/SettingsDialog.vue），状态不进 URL。
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
    // 远程通道的单联系人会话页（微信那侧的对端在左、本机回复在右）
    { path: "/remote/:peerId", component: () => import("../views/RemoteConversationView.vue") },
    { path: "/scheduled", component: () => import("../views/ScheduledView.vue") },
    { path: "/team", component: () => import("../views/TeamView.vue") },
    { path: "/plugin/:modeId", component: () => import("../views/PluginView.vue") },
    // 插件悬浮窗口内容（透明置顶小窗加载 #/plugin-window；Shell 按 meta.bare 只出 router-view）。
    { path: "/plugin-window", component: () => import("../views/PluginWindowView.vue"), meta: { bare: true } },
    { path: "/:pathMatch(.*)*", redirect: "/guid" },
  ];

  const router = createRouter({ history: createWebHashHistory(), routes });

  return router;
}
