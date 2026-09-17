<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import Icon from "@/features/shared/Icon.vue";
import SessionStatusIndicator from "@/features/shared/SessionStatusIndicator.vue";
import { useSessionStore } from "@/stores/session";
import { useSessionStatus } from "@/lib/session-status";

/**
 * 会话历史里的一行：行体点击切到该会话，hover / 键盘聚焦浮出重命名与删除，
 * 删除就地二次确认（覆盖整行）。重命名 / 删除状态都在行内 ——
 * 以前放在列表根上按 session.id 全局互斥，抽出后每行自洽，虚拟窗口里
 * 行的挂载/卸载不再需要向根状态报备。
 */
const props = defineProps<{
  session: { id: string; title: string; updatedAt: number };
  active: boolean;
}>();

const emit = defineEmits<{ navigate: [path: string] }>();

const sessionStore = useSessionStore();

/** 会话状态（未开始 / 运行 / 等待中 / 结束）：运行时派生，按 id 查，不动这一行的窄 prop。 */
const statusOf = useSessionStatus();
const status = computed(() => statusOf(props.session.id));

/* ===== 重命名（行内 input：Enter 提交 / Esc 取消 / 失焦提交） ===== */
const renaming = ref(false);
const draftTitle = ref("");
const renameInput = ref<HTMLInputElement | null>(null);

async function startRename(): Promise<void> {
  renaming.value = true;
  draftTitle.value = props.session.title;
  await nextTick();
  renameInput.value?.select();
}

function commitRename(): void {
  renaming.value = false;
  if (draftTitle.value.trim()) sessionStore.renameSession(props.session.id, draftTitle.value);
}

function cancelRename(): void {
  renaming.value = false;
}

/* ===== 删除（就地二次确认，历史不可恢复） ===== */
const pendingDelete = ref(false);
const deleteCancelEl = ref<HTMLButtonElement | null>(null);

/** 打开确认即把焦点移进面板（Esc 的接收者）；关闭时焦点回到触发按钮所在行。 */
async function openDeleteConfirm(): Promise<void> {
  pendingDelete.value = true;
  await nextTick();
  deleteCancelEl.value?.focus();
}

function cancelDelete(): void {
  pendingDelete.value = false;
}

function confirmDelete(): void {
  pendingDelete.value = false;
  sessionStore.deleteSession(props.session.id);
  if (props.active) emit("navigate", "/guid");
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
  <div class="group relative shrink-0">
    <input
      v-if="renaming"
      ref="renameInput"
      v-model="draftTitle"
      class="h-[34px] w-full rounded-[8px] border border-cyan/60 bg-panel px-2 text-[13px] text-foreground outline-none"
      aria-label="重命名会话"
      @keydown.enter.prevent="commitRename"
      @keydown.esc.prevent="cancelRename"
      @blur="commitRename"
    />
    <template v-else>
      <button
        class="flex h-[34px] w-full cursor-pointer items-center gap-2 rounded-[8px] px-2 pr-12 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
        :class="active ? 'bg-panel text-foreground' : 'text-dim hover:bg-panel hover:text-foreground'"
        :aria-current="active ? 'true' : undefined"
        @click="emit('navigate', `/conversation/${session.id}`)"
      >
        <span class="grid size-5 shrink-0 place-items-center rounded-[5px] bg-panel text-dim">
          <Icon name="message" :size="10" />
        </span>
        <span class="min-w-0 flex-1 truncate text-[13px]">{{ session.title }}</span>
        <SessionStatusIndicator :status="status" class="mr-0.5" />
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
          @click="startRename"
        >
          <Icon name="edit" :size="12" />
        </button>
        <button
          type="button"
          class="grid size-5 cursor-pointer place-items-center rounded-[5px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          :aria-label="'删除会话'"
          @click="openDeleteConfirm"
        >
          <Icon name="delete" :size="12" />
        </button>
      </div>

      <!-- 删除二次确认：覆盖整行，历史不可恢复 -->
      <div
        v-if="pendingDelete"
        class="absolute inset-0 flex items-center gap-1 rounded-[8px] border border-line-2 bg-panel px-2"
        @keydown.esc.prevent="cancelDelete"
      >
        <span class="min-w-0 flex-1 truncate text-[12px] text-dim">删除该会话？</span>
        <button
          type="button"
          class="h-5 shrink-0 cursor-pointer rounded-[5px] border border-line bg-panel-2 px-1.5 text-[11px] text-foreground transition-colors hover:border-line-2"
          @click="confirmDelete"
        >
          删除
        </button>
        <button
          ref="deleteCancelEl"
          type="button"
          class="h-5 shrink-0 cursor-pointer rounded-[5px] px-1.5 text-[11px] text-dim transition-colors hover:text-foreground"
          @click="cancelDelete"
        >
          取消
        </button>
      </div>
    </template>
  </div>
</template>
