<script setup lang="ts">
/**
 * 全局权限待决浮层：把**活跃态**权限卡片从会话页提到外壳顶层。
 *
 * 为什么必须全局：活跃态卡片原先只挂在 `ConversationView` 的输入区，而它是路由级的
 * 组件 —— 后台任务 / 远程助手 / 定时任务触发的 ACP 权限请求，或用户停在引导页 /
 * 团队 / 定时任务页时，宿主只发了系统通知（acp_host.rs 的 `host.notify`），界面上
 * 没有任何可裁决的入口，请求只能干等到 120s 超时被自动拒绝。这里读全局 store 信号
 * `pendingPermission`，任何路由都能弹出并裁决。
 *
 * 非模态：外层 `pointer-events-none`（不遮罩、不抢焦点），只有卡片本体可点 ——
 * 与 PermissionCard 自身的无障碍约定一致（它不是 alertdialog，也绝不能标 aria-modal：
 * 身后的页面照样可见可操作）。位置与 NoticeHost 同一竖列起点（标题栏之下），z 更高
 * 一位 —— 待裁决的权限比普通通知更该被先看到。
 */
import { useAgentStore } from "@/stores/agent";
import PermissionCard from "@/features/conversation/PermissionCard.vue";

const agent = useAgentStore();
</script>

<template>
  <div
    v-if="agent.pendingPermission"
    data-testid="permission-prompt-host"
    class="pointer-events-none fixed top-[52px] left-1/2 z-[95] w-[680px] max-w-[calc(100vw-24px)] -translate-x-1/2"
  >
    <div class="pointer-events-auto">
      <PermissionCard />
    </div>
  </div>
</template>
