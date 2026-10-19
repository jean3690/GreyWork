import { createRouter, createWebHashHistory, type Router, type RouteRecordRaw } from "vue-router";
import { currentFront } from "@/front/current";
import type { FrontSpec } from "@/front/types";

/**
 * GreyWork 外壳路由（hash 模式，桌面端与 Web 端共用一份产物形态）。
 * 「一比一复刻」路径树：
 *   /guid           全新对话引导页
 *   /conversation/  单 Agent 对话（历史会话）
 *   /assistants     助手库（Agent 设置页的读入口）
 *   /scheduled      自动化任务
 *   /team           团队
 *   /plugin/:modeId 插件贡献的模式页（组件取自 seam 的 modes 快照，无需注册路由）
 *
 * 设置不是路由：它是 Shell 持有的弹窗（components/SettingsDialog.vue），状态不进 URL。
 *
 * **路由表由前端声明拼装**（`front.features[].routes`），这里只留两条外壳约定：
 * 根路径重定向与兜底重定向。某个前端不启用某特性，它的路由就不存在 —— 于是深链接进来
 * 会落到兜底（`/guid`），而不是渲染一个该前端根本不该有的页面。
 *
 * 视图全部懒加载：ConversationView 的对话 store 链会把 ExcelJS / pptxgenjs /
 * jszip 焊进出入口 chunk，让从不产表格/幻灯的用户在开屏就解析这几百 KB 写入器。
 *
 * `front` 缺省取当前前端，因此既有调用方（含测试）不带参时行为与拆分前一致。
 */
export function createAppRouter(front: FrontSpec = currentFront()): Router {
  const routes: RouteRecordRaw[] = [
    // 落地页是外壳约定，不是某个特性的一部分 —— 但**它假定 guid 特性在场**：
    // 不带 guid 的前端必须自己决定落到哪（见 FrontSpec 的说明）。
    { path: "/", redirect: "/guid" },
    ...front.features.flatMap((feature) => feature.routes ?? []),
    { path: "/:pathMatch(.*)*", redirect: "/guid" },
  ];

  const router = createRouter({ history: createWebHashHistory(), routes });

  return router;
}
