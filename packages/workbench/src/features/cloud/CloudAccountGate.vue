<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useUserAccountStore } from "@/stores/user-account";
import UserAccountPane from "@/features/account/UserAccountPane.vue";
const account = useUserAccountStore();
const identity = computed(() => `${account.status?.baseUrl}/${account.session?.user.id}/${account.session?.device.id}`);
onMounted(() => {
  void account.refresh();
});
</script>

<template>
  <div v-if="account.session" :key="identity"><slot /></div>
  <div v-else class="mx-auto w-full max-w-[600px] py-6">
    <p class="mb-4 text-[13px] text-dim">登录服务器账号后，可使用网盘、资料库、能力下载和云端定时任务。</p>
    <UserAccountPane />
  </div>
</template>
