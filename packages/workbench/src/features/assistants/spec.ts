/**
 * 助手库（Agent 设置页的读入口）。侧栏「远程助手」入口指向这里。
 */
import type { Feature } from "@/front/types";

export const assistantsFeature: Feature = {
  id: "assistants",
  routes: [{ path: "/assistants", component: () => import("@/features/assistants/AssistantsView.vue") }],
  // 文案沿用拆分前 nav-items.ts 里的原文（侧栏文案目前不经 i18n）。
  nav: [{ path: "/assistants", label: "远程助手", icon: "robot" }],
};
