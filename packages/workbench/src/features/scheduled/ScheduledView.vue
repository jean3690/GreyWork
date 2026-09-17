<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { i18n } from "@/i18n";
import { useAgentStore } from "@/stores/agent";
import { useAutomationStore } from "@/stores/automation";
import { useNoticeStore } from "@/stores/notice";
import Icon from "@/features/shared/Icon.vue";
import ScheduleEditor from "@/features/scheduled/ScheduleEditor.vue";

/**
 * 定时任务页：automation store 清单 + 启停 + 立即运行 + 新建 + 行内编辑。
 * 删除走两步确认（与会话删除一致）；立即运行有真实在途态与结果通知。
 *
 * 编辑展开在卡片下方（`ScheduleEditor` 自带保存/取消）：触发时间要选、ACP 后端要挑，
 * 塞不进一行小输入框；新建即展开编辑器，省掉「先建空任务再点编辑」这一步。
 */
const t = i18n.global.t;
const router = useRouter();
const automation = useAutomationStore();
const agent = useAgentStore();
const notices = useNoticeStore();

const IS_SEED = new Set(["at-seed-1", "at-seed-2", "at-seed-3"]);

/** 待删除确认的任务 id（两步确认）；null = 无。 */
const pendingDeleteId = ref<string | null>(null);
/** 展开编辑器中的任务 id；null = 全部收拢。 */
const editingId = ref<string | null>(null);

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

/** 绑定的 ACP 后端展示名；后端已被删除时回落 id（不假装未绑定）。 */
function acpName(id: string | null | undefined): string | null {
  if (!id) return null;
  return agent.agentProviders.find((provider) => provider.id === id)?.name ?? id;
}

function createTask(): void {
  editingId.value = automation.add().id;
}

function commitEdit(
  id: string,
  patch: {
    name: string;
    intent: string;
    acpProviderId: string | null;
    cron: string | null;
    onceAt: number | null;
    schedule: string;
  },
): void {
  automation.update(id, patch);
  editingId.value = null;
}

function confirmDelete(id: string): void {
  pendingDeleteId.value = null;
  if (editingId.value === id) editingId.value = null;
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
  <section class="mx-auto min-h-0 h-full w-full max-w-[860px] overflow-y-auto px-4 py-6 sm:px-6">
    <div class="mb-5 flex items-end justify-between gap-3">
      <div>
        <h1 class="font-display text-[20px] font-bold tracking-tight text-foreground">{{ t("automation.title") }}</h1>
        <p class="mt-1 text-[12px] text-dim2">{{ t("automation.sub") }}</p>
      </div>
      <button
        class="flex h-8 cursor-pointer items-center gap-1.5 rounded-[10px] bg-accent px-3 text-[12px] font-medium text-accent-ink transition-opacity hover:opacity-90"
        data-testid="automation-create"
        @click="createTask"
      >
        <Icon name="plus" :size="13" />
        {{ t("automation.create") }}
      </button>
    </div>

    <div class="flex flex-col gap-2">
      <article
        v-for="task in automation.list"
        :key="task.id"
        class="flex flex-col rounded-[14px] border border-line bg-panel p-3.5"
        :class="{ 'opacity-60': !task.enabled }"
      >
        <div class="flex items-center gap-3">
          <span class="grid size-8 shrink-0 place-items-center rounded-[9px] bg-panel-2 text-dim">
            <Icon name="alarm-clock" :size="16" />
          </span>

          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-[13px] font-medium text-foreground">{{ task.name }}</span>
              <span class="shrink-0 rounded-full bg-panel-2 px-2 py-0.5 text-[10px] text-dim2">
                {{ task.schedule || (task.cron ?? t("automation.manualTrigger")) }}
              </span>
              <span
                v-if="task.onceAt"
                class="shrink-0 rounded-full border border-cyan/40 bg-cyan/10 px-2 py-0.5 text-[10px] text-cyan"
                data-testid="automation-once-badge"
              >
                {{ t("automation.onceBadge") }}
              </span>
              <span
                v-if="acpName(task.acpProviderId)"
                class="flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10px] text-dim2"
                data-testid="automation-acp-badge"
              >
                <Icon name="robot" :size="9" />
                {{ t("automation.acpBadge") }} · {{ acpName(task.acpProviderId) }}
              </span>
            </div>
            <div class="mt-0.5 truncate text-[11px] text-dim2">{{ task.intent }}</div>
            <div class="mt-0.5 font-mono text-[10px] text-dim2">
              {{ task.onceAt ? t("automation.onceBadge") : (task.cron ?? "—") }} ·
              {{ t("automation.lastRun", { last: fmtLastRun(task.lastRun) }) }}
            </div>
            <p v-if="IS_SEED.has(task.id)" class="mt-1 text-[10px] text-amber">{{ t("automation.seedHint") }}</p>
          </div>

          <div v-if="editingId !== task.id" class="flex shrink-0 items-center gap-1.5">
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
                type="button"
                class="grid size-7 cursor-pointer place-items-center rounded-[8px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground"
                :aria-label="t('automation.editName')"
                data-testid="automation-edit"
                @click="editingId = task.id"
              >
                <Icon name="edit" :size="13" />
              </button>
              <button
                class="flex h-7 cursor-pointer items-center gap-1 rounded-[8px] border border-line bg-panel px-2.5 text-[11px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="task.running || automation.list.some((a) => a.running)"
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
        </div>

        <!-- 行内编辑器：草稿在组件内部，保存即写回任务并收拢 -->
        <ScheduleEditor
          v-if="editingId === task.id"
          :key="task.id"
          :name="task.name"
          :intent="task.intent"
          :acp-provider-id="task.acpProviderId ?? null"
          :cron="task.cron ?? null"
          :once-at="task.onceAt ?? null"
          @save="(patch) => commitEdit(task.id, patch)"
          @cancel="editingId = null"
        />
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
          @click="createTask"
        >
          <Icon name="plus" :size="13" />
          {{ t("automation.create") }}
        </button>
      </div>
    </div>
  </section>
</template>
