<script setup lang="ts">
import { computed, nextTick, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { Check, Pencil, Trash2 } from "lucide-vue-next";
import { useChatStore } from "../../stores/chat";
import { useWorkspaceStore } from "../../stores/workspace";
import type { SessionRecord } from "../../stores/session";
import { useSessionStore } from "../../stores/session";

const { t } = useI18n();

const chat = useChatStore();
const workspaceStore = useWorkspaceStore();
const sessionStore = useSessionStore();
const route = useRoute();
const router = useRouter();

const openGroups = reactive(new Set<string>());

function toggleGroup(key: string): void {
  if (openGroups.has(key)) openGroups.delete(key);
  else openGroups.add(key);
}

/** 会话分组：按归属工作区分组（null = 普通对话），组内按更新时间倒序。 */
const groups = computed(() => {
  const byWorkspace = new Map<string | null, SessionRecord[]>();
  for (const session of sessionStore.sessions) {
    const list = byWorkspace.get(session.workspaceId) ?? [];
    list.push(session);
    byWorkspace.set(session.workspaceId, list);
  }
  const byTime = (list: SessionRecord[]): SessionRecord[] => [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  const out: Array<{ key: string; label: string; workspaceId: string | null; sessions: SessionRecord[] }> = [];
  for (const workspace of workspaceStore.workspaces) {
    const sessions = byTime(byWorkspace.get(workspace.id) ?? []);
    if (sessions.length) out.push({ key: workspace.id, label: workspace.name, workspaceId: workspace.id, sessions });
  }
  const plain = byTime(byWorkspace.get(null) ?? []);
  if (plain.length) out.push({ key: "plain", label: t("sidebar.plainChat"), workspaceId: null, sessions: plain });
  return out;
});

const firstGroup = computed(() => groups.value[0]?.key ?? null);

/* 初始展开首个分组。 */
if (firstGroup.value) openGroups.add(firstGroup.value);

interface ThreadState {
  kind: "run" | "review" | "done" | "idle";
}

/** 会话状态点：运行中（呼吸）/ 待审阅（amber Badge）/ 已完成（✓）/ 空闲。 */
function threadState(threadId: string): ThreadState {
  const messages = chat.threads[threadId] ?? [];
  if (threadId === chat.activeThreadId && chat.busy) return { kind: "run" };
  if (messages.some((m) => m.planPending)) return { kind: "review" };
  if (messages.some((m) => m.role === "assistant" && m.content)) return { kind: "done" };
  return { kind: "idle" };
}

/** 相对时间：分钟 / 小时 / 天，之后回落到日期。 */
function relativeTime(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return t("session.justNow");
  if (delta < 3600_000) return t("session.minutesAgo", { n: Math.floor(delta / 60_000) });
  if (delta < 86_400_000) return t("session.hoursAgo", { n: Math.floor(delta / 3600_000) });
  if (delta < 7 * 86_400_000) return t("session.daysAgo", { n: Math.floor(delta / 86_400_000) });
  return new Date(ts).toLocaleDateString();
}

async function openThread(threadId: string): Promise<void> {
  chat.activeThreadId = threadId;
  chat.ensure(threadId);
  await router.push(`/p/${String(route.params.workspaceId ?? "p-gw-main")}/chat`);
}

/* 重命名：✎ 进入行内编辑，Enter/blur 提交，Esc 取消。 */
const editingId = ref("");
const renameDraft = ref("");
const renameInput = ref<HTMLInputElement | null>(null);
async function startRename(session: SessionRecord): Promise<void> {
  editingId.value = session.id;
  renameDraft.value = session.title;
  await nextTick();
  renameInput.value?.focus();
  renameInput.value?.select();
}
function commitRename(session: SessionRecord): void {
  if (editingId.value !== session.id) return;
  sessionStore.renameSession(session.id, renameDraft.value);
  editingId.value = "";
}
function cancelRename(): void {
  editingId.value = "";
}

/* 删除：两段确认（× → ✓），2.5s 未确认自动还原。 */
const deleteConfirmId = ref("");
let deleteTimer: ReturnType<typeof setTimeout> | null = null;
function requestDelete(session: SessionRecord): void {
  if (deleteConfirmId.value === session.id) {
    sessionStore.deleteSession(session.id);
    deleteConfirmId.value = "";
    return;
  }
  deleteConfirmId.value = session.id;
  if (deleteTimer) clearTimeout(deleteTimer);
  deleteTimer = setTimeout(() => (deleteConfirmId.value = ""), 2500);
}
</script>

<template>
  <section>
    <p class="sb-cap">{{ t("sidebar.workspaces") }}</p>
    <div class="sb-list">
      <template v-for="group in groups" :key="group.key">
        <button
          class="sb-group__head"
          :aria-expanded="openGroups.has(group.key)"
          :aria-controls="`workspace-group-${group.key}`"
          @click="toggleGroup(group.key)"
        >
          <span>{{ group.label }}</span>
          <span class="sb-group__caret" :class="{ open: openGroups.has(group.key) }">▸</span>
        </button>
        <div
          v-if="openGroups.has(group.key)"
          :id="`workspace-group-${group.key}`"
          role="region"
          :aria-label="t('sidebar.threadsOfWorkspace', { workspace: group.label })"
          class="sb-list"
        >
          <div v-for="session in group.sessions" :key="session.id" class="sb-thread-row">
            <input
              v-if="editingId === session.id"
              ref="renameInput"
              v-model="renameDraft"
              class="sb-thread__rename"
              :placeholder="t('session.renamePlaceholder')"
              :aria-label="t('session.renameAria', { title: session.title })"
              @keydown.enter.prevent="commitRename(session)"
              @keydown.esc="cancelRename"
              @blur="commitRename(session)"
            />
            <button
              v-else
              class="sb-thread"
              :class="{ active: session.id === chat.activeThreadId }"
              :title="session.title"
              @click="openThread(session.id)"
            >
              <span
                class="sb-dot"
                :class="{
                  'sb-dot--run': threadState(session.id).kind === 'run',
                  'sb-dot--review': threadState(session.id).kind === 'review',
                }"
              ></span>
              <span class="sb-thread__title">{{ session.title }}</span>
              <span v-if="threadState(session.id).kind === 'done'" class="sb-state">✓</span>
              <span v-else class="sb-thread__time">{{ relativeTime(session.updatedAt) }}</span>
            </button>
            <div v-if="editingId !== session.id" class="sb-thread__actions">
              <template v-if="editingId !== session.id">
                <button
                  class="sb-thread__action"
                  :title="t('session.rename')"
                  :aria-label="t('session.renameAria', { title: session.title })"
                  @click="startRename(session)"
                >
                  <Pencil class="size-3" />
                </button>
                <button
                  class="sb-thread__action"
                  :class="{ 'sb-thread__action--confirm': deleteConfirmId === session.id }"
                  :title="deleteConfirmId === session.id ? t('session.deleteConfirm') : t('session.delete')"
                  :aria-label="t('session.deleteAria', { title: session.title })"
                  @click="requestDelete(session)"
                >
                  <Check v-if="deleteConfirmId === session.id" class="size-3" />
                  <Trash2 v-else class="size-3" />
                </button>
              </template>
            </div>
          </div>
          <p v-if="!group.sessions.length" class="footnote" style="margin: 4px 10px">{{ t("sidebar.noThreads") }}</p>
        </div>
      </template>
      <p v-if="!groups.length" class="footnote" style="margin: 4px 10px">{{ t("sidebar.noThreads") }}</p>
    </div>
  </section>
</template>
