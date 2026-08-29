<script setup lang="ts">
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { MessageSquarePlus } from "lucide-vue-next";
import { useChatStore } from "../../stores/chat";
import { useWorkspaceStore } from "../../stores/workspace";
import { useSessionStore } from "../../stores/session";
import { ensureMode } from "../../router/util";

const { t } = useI18n();

const chat = useChatStore();
const workspaceStore = useWorkspaceStore();
const sessionStore = useSessionStore();
const router = useRouter();

async function newTempChat(): Promise<void> {
  chat.activeThreadId = sessionStore.createSession(null).id;
  await ensureMode("chat");
  await router.push(`/p/${workspaceStore.activeWorkspaceId ?? "p-gw-main"}/chat`);
}
</script>

<template>
  <section>
    <p class="sb-cap">Chats</p>
    <div class="sb-list">
      <button class="sb-entry" @click="newTempChat">
        <span class="sb-entry__icon"><MessageSquarePlus class="size-3.5" /></span>
        {{ t("sidebar.tempChat") }}
      </button>
    </div>
  </section>
</template>
