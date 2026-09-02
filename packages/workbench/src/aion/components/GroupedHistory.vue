<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useSessionStore } from "../../stores/session";
import { useWorkspaceStore } from "../../stores/workspace";
import { groupSessions, type HistoryGroup } from "../lib/grouped";
import AionIcon from "./AionIcon.vue";

/**
 * AionUi 风格会话历史：按工作区分组（普通对话置底），支持名称过滤。
 * 行高 34px、圆角 8px，与 AionUi Sider 的 ConversationRow 一致。
 * 分组逻辑在 grouped.ts（纯函数，单测覆盖）。
 */
const props = defineProps<{
  activeSessionId: string | null;
}>();

const emit = defineEmits<{ navigate: [path: string] }>();

const sessionStore = useSessionStore();
const workspaceStore = useWorkspaceStore();
const query = ref("");

const groups = computed<HistoryGroup[]>(() =>
  groupSessions({
    workspaces: workspaceStore.workspaces,
    sessions: sessionStore.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      workspaceId: session.workspaceId,
    })),
    keyword: query.value,
  }),
);

const empty = computed(() => groups.value.every((group) => group.sessions.length === 0));

/* ===== 行内管理：重命名 / 删除 =====
   store 的 renameSession / deleteSession 早就有，只是没有 UI 入口。
   删除走行内二次确认（不可逆，且不带全局 confirm 弹窗）。 */
const renamingId = ref<string | null>(null);
const draftTitle = ref("");
const renameInput = ref<HTMLInputElement | null>(null);
const pendingDeleteId = ref<string | null>(null);

/** v-for 内的模板 ref 会被 Vue 收成数组，用函数 ref 精确绑定当前那一个 input。 */
function bindRenameInput(el: unknown): void {
  renameInput.value = (el as HTMLInputElement | null) ?? null;
}

async function startRename(session: { id: string; title: string }): Promise<void> {
  renamingId.value = session.id;
  draftTitle.value = session.title;
  await nextTick();
  renameInput.value?.select();
}

function commitRename(): void {
  const id = renamingId.value;
  renamingId.value = null;
  if (id && draftTitle.value.trim()) sessionStore.renameSession(id, draftTitle.value);
}

function cancelRename(): void {
  renamingId.value = null;
}

function confirmDelete(id: string): void {
  pendingDeleteId.value = null;
  sessionStore.deleteSession(id);
  // 删掉正打开的那条：路由还指向已消失的会话，退回 Guid 页。
  if (props.activeSessionId === id) emit("navigate", "/guid");
}

function fmtTime(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2">
    <label class="flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] border border-line-2 bg-panel px-2">
      <AionIcon name="search" :size="13" class="text-dim2" />
      <input
        v-model="query"
        class="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-dim2"
        placeholder="搜索会话"
        aria-label="搜索会话"
      />
      <button
        v-if="query"
        class="grid size-4 cursor-pointer place-items-center text-dim2 hover:text-foreground"
        aria-label="清空搜索"
        @click="query = ''"
      >
        <AionIcon name="close" :size="12" />
      </button>
    </label>

    <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
      <template v-for="(group, gi) in groups" :key="group.id ?? `free-${gi}`">
        <div class="mt-0.5 flex items-center gap-1.5 px-2 text-[11px] font-medium text-dim2">
          <span class="truncate">{{ group.name }}</span>
          <span class="ml-auto text-[10px] tabular-nums">{{ group.sessions.length }}</span>
        </div>
        <div v-for="session in group.sessions" :key="session.id" class="group relative shrink-0">
          <!-- 重命名：行内 input，Enter 提交 / Esc 取消 / 失焦提交 -->
          <input
            v-if="renamingId === session.id"
            :ref="bindRenameInput"
            v-model="draftTitle"
            class="h-[34px] w-full rounded-[8px] border border-cyan/60 bg-panel px-2 text-[13px] text-foreground outline-none"
            :aria-label="'重命名会话'"
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="cancelRename"
            @blur="commitRename"
          />
          <template v-else>
            <button
              class="flex h-[34px] w-full cursor-pointer items-center gap-2 rounded-[8px] px-2 pr-12 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
              :class="props.activeSessionId === session.id ? 'bg-panel text-foreground' : 'text-dim hover:bg-panel hover:text-foreground'"
              :aria-current="props.activeSessionId === session.id ? 'true' : undefined"
              @click="emit('navigate', `/conversation/${session.id}`)"
            >
              <span class="grid size-5 shrink-0 place-items-center rounded-[5px] bg-panel text-dim">
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 48 48"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="block"
                  aria-hidden="true"
                >
                  <path d="M8 8H40V32H24L14 40V32H8V8Z" />
                </svg>
              </span>
              <span class="min-w-0 flex-1 truncate text-[13px]">{{ session.title }}</span>
              <span class="shrink-0 text-[10px] text-dim2 tabular-nums">{{ fmtTime(session.updatedAt) }}</span>
            </button>

            <!-- hover / 键盘聚焦时浮出的行内操作（pr-12 已为它留位） -->
            <div
              class="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
            >
              <button
                type="button"
                class="grid size-5 cursor-pointer place-items-center rounded-[5px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
                :aria-label="'重命名会话'"
                @click="startRename(session)"
              >
                <AionIcon name="edit" :size="12" />
              </button>
              <button
                type="button"
                class="grid size-5 cursor-pointer place-items-center rounded-[5px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
                :aria-label="'删除会话'"
                @click="pendingDeleteId = session.id"
              >
                <AionIcon name="delete" :size="12" />
              </button>
            </div>

            <!-- 删除二次确认：覆盖整行，历史不可恢复 -->
            <div
              v-if="pendingDeleteId === session.id"
              class="absolute inset-0 flex items-center gap-1 rounded-[8px] border border-line-2 bg-panel px-2"
            >
              <span class="min-w-0 flex-1 truncate text-[12px] text-dim">删除该会话？</span>
              <button
                type="button"
                class="h-5 shrink-0 cursor-pointer rounded-[5px] border border-line bg-panel-2 px-1.5 text-[11px] text-foreground transition-colors hover:border-line-2"
                @click="confirmDelete(session.id)"
              >
                删除
              </button>
              <button
                type="button"
                class="h-5 shrink-0 cursor-pointer rounded-[5px] px-1.5 text-[11px] text-dim transition-colors hover:text-foreground"
                @click="pendingDeleteId = null"
              >
                取消
              </button>
            </div>
          </template>
        </div>
      </template>

      <p v-if="empty" class="px-2 pt-8 text-center text-[12px] text-dim2">
        {{ query ? "没有匹配的会话" : "暂无历史会话，先开个新对话" }}
      </p>
    </div>
  </div>
</template>
