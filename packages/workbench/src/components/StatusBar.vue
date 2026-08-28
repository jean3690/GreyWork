<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { GitBranch } from "lucide-vue-next";
import { useAgentStore } from "../stores/agent";
import { workspaceGit } from "../stores/vfs";

const { t } = useI18n();

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
    <span class="statusbar__item" :title="branchError ? t('statusbar.gitUnavailable') : t('statusbar.currentBranch')">
      <GitBranch class="size-3" />{{ branchError ? "—" : branch }}
    </span>
    <span class="statusbar__item" :title="t('statusbar.tokenUsageHint')">Token —</span>
    <span class="statusbar__spacer"></span>
    <span class="statusbar__item" :title="agentStore.acpAvailable ? t('statusbar.acpHostReady') : t('statusbar.webPreviewEnv')">
      <span class="statusbar__dot" :class="{ on: agentStore.acpAvailable }"></span>
      {{ agentStore.acpAvailable ? t("statusbar.acpReady") : t("statusbar.webPreview") }}
    </span>
  </footer>
</template>
