/**
 * 远程通道：六条 IM 通道的注册面板 + 单联系人会话页。
 *
 * **本特性的 `setup` 拥有 `remote-assistant` store 的 `init()`**：那个 store 就是六条通道的
 * 监听注册与自动连接层（见 `stores/remote-assistant/lifecycle.ts`，它自己写着「Shell 挂载时
 * 只调 init() 一次」）。把它挂在这里而不是外壳接线上，是为了让「前端没启用 channels」
 * 自动等于「不注册六条通道的监听、不按设置自动连接」—— 否则前端得记得同步两处清单，
 * 迟早漏一处，表现为「Web 端莫名拨了微信」。
 */
import type { Feature } from "@/front/types";
import { useRemoteAssistantStore } from "@/stores/remote-assistant";

export const channelsFeature: Feature = {
  id: "channels",
  routes: [{ path: "/remote/:peerId", component: () => import("@/features/channels/RemoteConversationView.vue") }],
  setup: () => useRemoteAssistantStore().init(),
};
