/**
 * 单 Agent 对话（历史会话页）。这是本产品的主界面，任何前端都该带上。
 */
import type { Feature } from "@/front/types";

export const conversationFeature: Feature = {
  id: "conversation",
  routes: [{ path: "/conversation/:conversationId?", component: () => import("@/features/conversation/ConversationView.vue") }],
};
