<script setup lang="ts">
import { useRouter } from "vue-router";
import { MessageSquarePlus } from "lucide-vue-next";
import { useChatStore } from "../../stores/chat";
import { useProjectStore } from "../../stores/project";
import { ensureMode } from "../../router/util";

const chat = useChatStore();
const projectStore = useProjectStore();
const router = useRouter();

async function newTempChat(): Promise<void> {
  chat.activeThreadId = projectStore.startNewThread(null);
  await ensureMode("chat");
  await router.push(`/p/${projectStore.activeProjectId ?? "p-gw-main"}/chat`);
}
</script>

<template>
  <section>
    <p class="sb-cap">Chats</p>
    <div class="sb-list">
      <button class="sb-entry" @click="newTempChat">
        <span class="sb-entry__icon"><MessageSquarePlus class="size-3.5" /></span>
        临时对话
      </button>
    </div>
  </section>
</template>
