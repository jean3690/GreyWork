<script setup lang="ts">
import { computed, reactive } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useChatStore } from "../../stores/chat";
import { useProjectStore } from "../../stores/project";

const { t } = useI18n();

const chat = useChatStore();
const projectStore = useProjectStore();
const route = useRoute();
const router = useRouter();

const openGroups = reactive(new Set<string>());

function toggleGroup(name: string): void {
  if (openGroups.has(name)) openGroups.delete(name);
  else openGroups.add(name);
}

interface ThreadState {
  kind: "run" | "review" | "done" | "idle";
}

/** 线程状态点：运行中（呼吸）/ 待审阅（amber Badge）/ 已完成（✓）/ 空闲。 */
function threadState(threadId: string): ThreadState {
  const messages = chat.threads[threadId] ?? [];
  if (threadId === chat.activeThreadId && chat.busy) return { kind: "run" };
  if (messages.some((m) => m.planPending)) return { kind: "review" };
  if (messages.some((m) => m.role === "assistant" && m.content)) return { kind: "done" };
  return { kind: "idle" };
}

const groups = computed(() =>
  projectStore.threadGroups.map((group) => ({
    ...group,
    expanded: openGroups.has(group.project),
  })),
);

const firstGroup = computed(() => groups.value[0]?.project ?? null);

/* 初始展开首个分组。 */
if (firstGroup.value) openGroups.add(firstGroup.value);

async function openThread(threadId: string): Promise<void> {
  chat.activeThreadId = threadId;
  chat.ensure(threadId);
  await router.push(`/p/${String(route.params.projectId ?? "p-gw-main")}/chat`);
}
</script>

<template>
  <section>
    <p class="sb-cap">Projects</p>
    <div class="sb-list">
      <div v-for="group in groups" :key="group.project" class="sb-list">
        <button
          class="sb-group__head"
          :aria-expanded="group.expanded"
          :aria-controls="`project-group-${group.project}`"
          @click="toggleGroup(group.project)"
        >
          <span>{{ group.project }}</span>
          <span class="sb-group__caret" :class="{ open: group.expanded }">▸</span>
        </button>
        <div
          v-if="group.expanded"
          :id="`project-group-${group.project}`"
          role="region"
          :aria-label="t('sidebar.threadsOfProject', { project: group.project })"
        >
          <button
            v-for="thread in group.threads"
            :key="thread.id"
            class="sb-thread"
            :class="{ active: thread.id === chat.activeThreadId }"
            @click="openThread(thread.id)"
          >
            <span
              class="sb-dot"
              :class="{
                'sb-dot--run': threadState(thread.id).kind === 'run',
                'sb-dot--review': threadState(thread.id).kind === 'review',
              }"
            ></span>
            <span class="sb-thread__title">{{ thread.title }}</span>
            <span v-if="threadState(thread.id).kind === 'done'" class="sb-state">✓</span>
            <span v-else class="sb-thread__time">{{ thread.time }}</span>
          </button>
          <p v-if="!group.threads.length" class="footnote" style="margin: 4px 10px">{{ t("sidebar.noThreads") }}</p>
        </div>
      </div>
    </div>
  </section>
</template>
