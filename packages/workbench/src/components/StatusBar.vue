<script setup lang="ts">
import { onMounted, ref } from "vue";
import { GitBranch } from "lucide-vue-next";
import { useAgentStore } from "../stores/agent";
import { workspaceGit } from "../stores/vfs";

const agentStore = useAgentStore();

const branch = ref("…");
const branchError = ref(false);

onMounted(async () => {
  try {
    branch.value = await workspaceGit.currentBranch();
  } catch {
    branchError.value = true;
  }
});
</script>

<template>
  <footer class="statusbar" data-testid="status-bar">
    <span class="statusbar__item" :title="branchError ? 'Git 服务不可用' : '当前分支'">
      <GitBranch class="size-3" />{{ branchError ? "—" : branch }}
    </span>
    <span class="statusbar__item" title="Token 用量：会话计数器尚未接入">Token —</span>
    <span class="statusbar__spacer"></span>
    <span class="statusbar__item" :title="agentStore.acpAvailable ? '桌面端 ACP 宿主就绪' : 'Web 预览环境'">
      <span class="statusbar__dot" :class="{ on: agentStore.acpAvailable }"></span>
      {{ agentStore.acpAvailable ? "ACP 就绪" : "Web 预览" }}
    </span>
  </footer>
</template>
