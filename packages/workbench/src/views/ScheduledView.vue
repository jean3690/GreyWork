<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { i18n } from "../i18n";
import { useAutomationStore } from "../stores/automation";
import { useNoticeStore } from "../stores/notice";
import Icon from "../components/Icon.vue";

/**
 * 定时任务页：automation store 清单 + 启停 + 立即运行 + 新建 + 行内编辑。
 * 删除走两步确认（与会话删除一致）；立即运行有真实在途态与结果通知。
 */
const t = i18n.global.t;
const router = useRouter();
const automation = useAutomationStore();
const notices = useNoticeStore();

const IS_SEED = new Set(["at-seed-1", "at-seed-2", "at-seed-3"]);

/** 待删除确认的任务 id（两步确认）；null = 无。 */
const pendingDeleteId = ref<string | null>(null);
/** 编辑中的任务 id + 草稿。 */
const editingId = ref<string | null>(null);
const editDraft = ref({ name: "", schedule: "", intent: "" });

function fmtLastRun(ts: number): string {
  if (!ts) return t("automation.neverRun");
  return new Date(ts).toLocaleString(i18n.global.locale.value, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function startEdit(task: { id: string; name: string; schedule: string; intent: string }): void {
  editingId.value = task.id;
  editDraft.value = { name: task.name, schedule: task.schedule, intent: task.intent };
}

function commitEdit(): void {
  if (editingId.value === null) return;
  automation.update(editingId.value, { ...editDraft.value });
  editingId.value = null;
}

function confirmDelete(id: string): void {
  pendingDeleteId.value = null;
  automation.remove(id);
}

function runNow(id: string, name: string): void {
  const result = automation.runNow(id);
  if (result === "started") {
    const action = {
      label: t("automation.openConversation"),
      run: () => void router.push(`/conversation/${automation.lastRunSessionId ?? ""}`),
    };
    notices.success(t("automation.runStarted", { name }), undefined, { action });
  } else if (result === "busy") {
    notices.info(t("automation.runBusy"), undefined, { key: "automation-run-busy" });
  }
}
</script>

<template>
  <section class="mx-auto min-h-0 w-full max-w-[860px] overflow-y-auto px-4 py-6 sm:px-6">
    <div class="mb-5 flex items-end justify-between gap-3">
      <div>
        <h1 class="font-display text-[20px] font-bold tracking-tight text-foreground">{{ t("automation.title") }}</h1>
        <p class="mt-1 text-[12px] text-dim2">{{ t("automation.sub") }}</p>
      </div>
      <button
        class="flex h-8 cursor-pointer items-center gap-1.5 rounded-[10px] bg-accent px-3 text-[12px] font-medium text-accent-ink transition-opacity hover:opacity-90"
        @click="automation.add()"
      >
        <Icon name="plus" :size="13" />
        {{ t("automation.create") }}
      </button>
    </div>

    <div class="flex flex-col gap-2">
      <article
        v-for="task in automation.list"
        :key="task.id"
        class="flex items-center gap-3 rounded-[14px] border border-line bg-panel p-3.5"
        :class="{ 'opacity-60': !task.enabled }"
      >
        <span class="grid size-8 shrink-0 place-items-center rounded-[9px] bg-panel-2 text-dim">
          <Icon name="alarm-clock" :size="16" />
        </span>

        <!-- 行内编辑态 -->
        <div v-if="editingId === task.id" class="flex min-w-0 flex-1 flex-col gap-1.5">
          <input
            v-model="editDraft.name"
            class="rounded-[8px] border border-line bg-panel px-2 py-1 text-[13px] text-foreground outline-none focus:border-line-2"
            :placeholder="t('automation.namePlaceholder')"
          />
          <div class="flex gap-1.5">
            <input
              v-model="editDraft.schedule"
              class="w-40 rounded-[8px] border border-line bg-panel px-2 py-1 text-[11px] text-foreground outline-none focus:border-line-2"
              :placeholder="t('automation.schedulePlaceholder')"
            />
            <input
              v-model="editDraft.intent"
              class="min-w-0 flex-1 rounded-[8px] border border-line bg-panel px-2 py-1 text-[11px] text-foreground outline-none focus:border-line-2"
              :placeholder="t('automation.intentPlaceholder')"
            />
          </div>
        </div>

        <!-- 展示态 -->
        <div v-else class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="truncate text-[13px] font-medium text-foreground">{{ task.name }}</span>
            <span class="shrink-0 rounded-full bg-panel-2 px-2 py-0.5 text-[10px] text-dim2">{{ task.schedule }}</span>
          </div>
          <div class="mt-0.5 truncate text-[11px] text-dim2">{{ task.intent }}</div>
          <div class="mt-0.5 text-[10px] text-dim2">{{ t("automation.lastRun", { last: fmtLastRun(task.lastRun) }) }}</div>
          <p v-if="IS_SEED.has(task.id)" class="mt-1 text-[10px] text-amber">{{ t("automation.seedHint") }}</p>
        </div>

        <div class="flex shrink-0 items-center gap-1.5">
          <template v-if="pendingDeleteId === task.id">
            <span class="text-[11px] text-foreground">{{ t("automation.removeConfirm") }}</span>
            <button
              type="button"
              class="h-7 cursor-pointer rounded-[8px] bg-orange/90 px-2 text-[11px] font-medium text-white transition-opacity hover:opacity-90"
              @click="confirmDelete(task.id)"
            >
              {{ t("common.delete") }}
            </button>
            <button
              type="button"
              class="h-7 cursor-pointer rounded-[8px] border border-line bg-panel px-2 text-[11px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
              @click="pendingDeleteId = null"
            >
              {{ t("common.cancel") }}
            </button>
          </template>
          <template v-else>
            <button
              v-if="editingId === task.id"
              type="button"
              class="h-7 cursor-pointer rounded-[8px] border border-line bg-panel px-2 text-[11px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
              @click="commitEdit"
            >
              {{ t("common.saveAction") }}
            </button>
            <button
              type="button"
              class="grid size-7 cursor-pointer place-items-center rounded-[8px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground"
              :aria-label="t('automation.editName')"
              @click="startEdit(task)"
            >
              <Icon name="edit" :size="13" />
            </button>
            <button
              class="flex h-7 cursor-pointer items-center gap-1 rounded-[8px] border border-line bg-panel px-2.5 text-[11px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="task.running || automation.list.some((a) => a.running) || editingId !== null"
              @click="runNow(task.id, task.name)"
            >
              <Icon name="lightning" :size="12" />
              {{ task.running ? t("automation.running") : t("automation.runNow") }}
            </button>
            <button
              class="grid size-7 cursor-pointer place-items-center rounded-[8px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground"
              :aria-label="task.enabled ? t('automation.disable') : t('automation.enable')"
              @click="automation.setEnabled(task.id, !task.enabled)"
            >
              <Icon :name="task.enabled ? 'check-one' : 'close-one'" :size="14" />
            </button>
            <button
              class="grid size-7 cursor-pointer place-items-center rounded-[8px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground"
              :aria-label="t('automation.remove')"
              @click="pendingDeleteId = task.id"
            >
              <Icon name="delete" :size="14" />
            </button>
          </template>
        </div>
      </article>

      <!-- 空态 CTA -->
      <div
        v-if="automation.list.length === 0"
        class="flex flex-col items-center gap-3 rounded-[14px] border border-dashed border-line-2 bg-panel py-14 text-center"
      >
        <span class="grid size-10 place-items-center rounded-[12px] bg-panel-2 text-dim">
          <Icon name="alarm-clock" :size="17" />
        </span>
        <p class="max-w-[380px] text-[12px] leading-relaxed text-dim2">{{ t("automation.emptyHint") }}</p>
        <button
          class="flex h-8 cursor-pointer items-center gap-1.5 rounded-[10px] bg-accent px-3 text-[12px] font-medium text-accent-ink transition-opacity hover:opacity-90"
          @click="automation.add()"
        >
          <Icon name="plus" :size="13" />
          {{ t("automation.create") }}
        </button>
      </div>
    </div>
  </section>
</template>
