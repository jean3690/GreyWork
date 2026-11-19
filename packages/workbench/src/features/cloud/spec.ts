import type { Feature } from "@/front/types";
export const cloudFeature: Feature = {
  id: "cloud",
  routes: [{ path: "/more/:section?", component: () => import("./MoreView.vue") }],
  nav: [{ path: "/more", label: "更多", icon: "more" }],
};
