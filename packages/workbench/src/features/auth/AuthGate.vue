<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { onAuthRequired, runtimeMode } from "@greywork/host-ipc";
import { needsLogin } from "./gate";
import LoginView from "./LoginView.vue";

/**
 * 登录门：只拦服务端态的未认证访问。
 *
 * 用三态而不是布尔 —— 服务端态下「探测 /api/session」是异步的，探测期间既不能放行
 * （Shell 一挂载就会发出一批必然 401 的命令），也不能立刻显示登录表单（每次刷新都闪
 * 一下登录框），所以 pending 期间什么都不渲染。
 *
 * desktop / browser-preview 同步落到 open：前者是本地壳、没有会话概念，后者没有宿主。
 * 前提是入口在 mount 之前已 await 过 `initRuntimeMode()` —— 否则服务端态会被误判成
 * browser-preview（探测结果还没写下来），登录门就永远不弹。
 */
const mode = runtimeMode();
const state = ref<"pending" | "gated" | "open">(mode === "server" ? "pending" : "open");
let offAuthRequired: (() => void) | undefined;

onMounted(async () => {
  if (mode !== "server") return;
  // 先订阅再探测：两者之间若恰好有命令拿到 401，不会被漏掉。
  offAuthRequired = onAuthRequired(() => {
    state.value = "gated";
  });
  const gated = await needsLogin();
  // 探测期间已被 401 推上门时保持 gated：那是更新的信号，不该被这一次探测结果盖回去。
  if (state.value === "pending") state.value = gated ? "gated" : "open";
});

onUnmounted(() => offAuthRequired?.());
</script>

<template>
  <LoginView v-if="state === 'gated'" @authenticated="state = 'open'" />
  <slot v-else-if="state === 'open'" />
</template>
