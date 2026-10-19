/**
 * 团队（多 Agent 协同）。侧栏「团队」入口指向这里。
 */
import type { Feature } from "@/front/types";

export const teamFeature: Feature = {
  id: "team",
  routes: [{ path: "/team", component: () => import("@/features/team/TeamView.vue") }],
  nav: [{ path: "/team", label: "团队", icon: "peoples" }],
};
