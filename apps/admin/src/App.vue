<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { clearSession } from "./api/session";

const router = useRouter();

/**
 * 401 的统一出口：token 过期 / 被踢下线 / 账号被禁用时，任何请求都可能先撞上 401。
 * 由这里统一回登录页，业务页面不用各写一遍。
 */
function onUnauthorized(): void {
  clearSession();
  if (router.currentRoute.value.path !== "/login") {
    void router.replace({ path: "/login", query: { redirect: router.currentRoute.value.fullPath } });
  }
}

onMounted(() => window.addEventListener("grey:admin-unauthorized", onUnauthorized));
onUnmounted(() => window.removeEventListener("grey:admin-unauthorized", onUnauthorized));
</script>

<template>
  <router-view />
</template>
