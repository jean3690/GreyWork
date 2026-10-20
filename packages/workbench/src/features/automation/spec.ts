/**
 * 自动化任务（定时/触发式）。侧栏「自动化任务」入口指向这里。
 */
import type { Feature } from "@/front/types";

export const automationFeature: Feature = {
  id: "automation",
  routes: [{ path: "/scheduled", component: () => import("@/features/automation/AutomationView.vue") }],
  nav: [{ path: "/scheduled", label: "自动化任务", icon: "alarm-clock" }],
};
