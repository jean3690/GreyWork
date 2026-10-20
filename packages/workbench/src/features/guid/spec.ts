/**
 * 全新对话引导页。默认落地页（根路径重定向到 /guid 在 router 里，属外壳约定）。
 */
import type { Feature } from "@/front/types";

export const guidFeature: Feature = {
  id: "guid",
  routes: [{ path: "/guid", component: () => import("@/features/guid/GuidView.vue") }],
};
