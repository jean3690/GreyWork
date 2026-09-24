<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { i18n } from "@/i18n";
import { useAgentStore } from "@/stores/agent";
import { useAutomationStore, type AutomationTask } from "@/stores/automation";
import { useNoticeStore } from "@/stores/notice";
import { nextCronRuns } from "@/lib/cron";
import type { AutomationRunRow } from "@/lib/automations-backend";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import ScheduleEditor from "@/features/scheduled/ScheduleEditor.vue";

/**
 * 定时任务页：automation store 清单 + 启停 + 立即运行 + 新建 + 行内编辑 + 运行记录回看。
 * 顶部工具条给搜索 / 类型筛选 / 状态筛选 / 排序；列表按启用态分组（启用中在上）。
 * 删除走两步确认；立即运行有真实在途态与结果通知；每张卡可展开近 5 次运行记录，
 * 成功/失败带色点，能点进关联会话（含宿主无人值守兜底跑）。
 *
 * 下次运行时刻由 `nextCronRuns` 就地推算（cron 循环）或取 `onceAt`（一次性未跑）；
 * 每 30s 走一次时钟让「下次运行」随时间刷新，组件卸载即停。
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
/** 展开运行记录的任务 id（一次一个）；null = 全部收拢。 */
const expandedId = ref<string | null>(null);

type TypeFilter = "all" | "cron" | "once" | "manual";
type StatusFilter = "all" | "enabled" | "paused";
type SortKey = "next" | "name" | "lastRun";

const search = ref("");
const typeFilter = ref<TypeFilter>("all");
const statusFilter = ref<StatusFilter>("all");
const sortKey = ref<SortKey>("next");

/** 30s 时钟：驱动「下次运行」重算（cron 到点后自然滚到下一次）。 */
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  clock = setInterval(() => {
    now.value = Date.now();
  }, 30_000);
});
onBeforeUnmount(() => {
  if (clock !== null) clearInterval(clock);
});

function taskType(task: AutomationTask): TypeFilter {
  if (task.onceAt) return "once";
  if (task.cron) return "cron";
  return "manual";
}

/** 类型图标（循环=history / 一次性=calendar / 手动=lightning）。 */
function typeIcon(task: AutomationTask): string {
  const kind = taskType(task);
  return kind === "once" ? "calendar" : kind === "cron" ? "history" : "lightning";
}

/** 下次触发时刻（epoch ms）；手动 / 已跑完的一次性 / 无效表达式 → null。依赖 now 重算。 */
function nextRunAt(task: AutomationTask): number | null {
  void now.value;
  if (task.onceAt) return task.lastRun ? null : task.onceAt;
  if (task.cron) return nextCronRuns(task.cron, new Date(now.value), 1)[0]?.getTime() ?? null;
  return null;
}

function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString(i18n.global.locale.value, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtLastRun(ts: number): string {
  if (!ts) return t("automation.neverRun");
  return fmtDateTime(ts);
}

/** 绑定的 ACP 后端展示名；后端已被删除时回落 id（不假装未绑定）。 */
function acpName(id: string | null | undefined): string | null {
  if (!id) return null;
  return agent.agentProviders.find((provider) => provider.id === id)?.name ?? id;
}

/** 该任务的运行记录（新→旧；store 保证顺序）。 */
function runsFor(taskId: string): AutomationRunRow[] {
  return automation.runs.filter((run) => run.taskId === taskId);
}

/** 最近一次运行结果（用于卡片上的成功/失败色点）。 */
function lastResult(taskId: string): AutomationRunRow | null {
  return runsFor(taskId)[0] ?? null;
}

function modeLabel(mode: AutomationRunRow["mode"]): string {
  return mode === "host" ? t("automation.modeHost") : mode === "acp" ? t("automation.modeAcp") : t("automation.modeLlm");
}

function openSession(sessionId: string | null): void {
  if (sessionId) void router.push(`/conversation/${sessionId}`);
}

function toggleHistory(id: string): void {
  expandedId.value = expandedId.value === id ? null : id;
}

/** 搜索 + 类型 + 状态过滤后按排序键排序（下次运行 / 名称 / 最近运行）。 */
const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  const items = automation.list.filter((task) => {
    if (typeFilter.value !== "all" && taskType(task) !== typeFilter.value) return false;
    if (statusFilter.value === "enabled" && !task.enabled) return false;
    if (statusFilter.value === "paused" && task.enabled) return false;
    if (q && !`${task.name} ${task.intent}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const key = sortKey.value;
  return items.sort((a, b) => {
    if (key === "name") return a.name.localeCompare(b.name, i18n.global.locale.value);
    if (key === "lastRun") return (b.lastRun || 0) - (a.lastRun || 0);
    const na = nextRunAt(a);
    const nb = nextRunAt(b);
    if (na === null && nb === null) return 0;
    if (na === null) return 1; // 无排期沉底
    if (nb === null) return -1;
    return na - nb; // 最近的排前
  });
});

/** 启用态分组（启用中在上，已停用在下）。 */
const sections = computed(() => {
  const enabled = visible.value.filter((task) => task.enabled);
  const paused = visible.value.filter((task) => !task.enabled);
  const out: { key: string; label: string; items: AutomationTask[] }[] = [];
  if (enabled.length) out.push({ key: "enabled", label: t("automation.statusEnabled"), items: enabled });
  if (paused.length) out.push({ key: "paused", label: t("automation.statusPaused"), items: paused });
  return out;
});

/** 两个分组都有内容且未按状态收窄时才显示分组标题（避免单组时冗余）。 */
const showGroupHeaders = computed(() => statusFilter.value === "all" && sections.value.length > 1);

const TYPE_FILTERS: { id: TypeFilter; label: string }[] = [
  { id: "all", label: "automation.typeAll" },
  { id: "cron", label: "automation.typeCron" },
  { id: "once", label: "automation.typeOnce" },
  { id: "manual", label: "automation.typeManual" },
];
const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "automation.statusAll" },
  { id: "enabled", label: "automation.statusEnabled" },
  { id: "paused", label: "automation.statusPaused" },
];

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
  if (expandedId.value === id) expandedId.value = null;
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

    <!-- 工具条：搜索 / 类型 / 状态 / 排序（有任务才显示） -->
    <div v-if="automation.list.length > 0" class="mb-4 flex flex-wrap items-center gap-2">
      <label class="relative flex h-8 min-w-[180px] flex-1 items-center">
        <Icon name="search" :size="13" class="pointer-events-none absolute left-2.5 text-dim2" />
        <input
          v-model="search"
          type="text"
          data-testid="automation-search"
          :placeholder="t('automation.search')"
          :aria-label="t('automation.search')"
          class="h-8 w-full rounded-[9px] border border-line bg-panel pl-8 pr-2.5 text-[12px] text-foreground placeholder:text-dim2 focus-visible:border-line-2 focus-visible:outline-none"
        />
      </label>

      <div class="flex items-center gap-1 rounded-[9px] border border-line bg-panel p-0.5" role="group">
        <button
          v-for="f in TYPE_FILTERS"
          :key="f.id"
          type="button"
          :data-testid="`automation-type-${f.id}`"
          :aria-pressed="typeFilter === f.id"
          class="h-7 cursor-pointer rounded-[7px] px-2.5 text-[11.5px] transition-colors"
          :class="typeFilter === f.id ? 'bg-panel-2 text-foreground' : 'text-dim2 hover:text-foreground'"
          @click="typeFilter = f.id"
        >
          {{ t(f.label) }}
        </button>
      </div>

      <div class="flex items-center gap-1 rounded-[9px] border border-line bg-panel p-0.5" role="group">
        <button
          v-for="f in STATUS_FILTERS"
          :key="f.id"
          type="button"
          :data-testid="`automation-status-${f.id}`"
          :aria-pressed="statusFilter === f.id"
          class="h-7 cursor-pointer rounded-[7px] px-2.5 text-[11.5px] transition-colors"
          :class="statusFilter === f.id ? 'bg-panel-2 text-foreground' : 'text-dim2 hover:text-foreground'"
          @click="statusFilter = f.id"
        >
          {{ t(f.label) }}
        </button>
      </div>

      <label class="flex h-8 items-center gap-1.5 rounded-[9px] border border-line bg-panel px-2.5 text-[11.5px] text-dim2">
        {{ t("automation.sortBy") }}
        <select
          v-model="sortKey"
          data-testid="automation-sort"
          :aria-label="t('automation.sortBy')"
          class="cursor-pointer bg-transparent text-[11.5px] text-foreground focus-visible:outline-none"
        >
          <option value="next">{{ t("automation.sortNext") }}</option>
          <option value="name">{{ t("automation.sortName") }}</option>
          <option value="lastRun">{{ t("automation.sortLastRun") }}</option>
        </select>
      </label>
    </div>

    <div class="flex flex-col gap-4">
      <div v-for="section in sections" :key="section.key" class="flex flex-col gap-2">
        <h2
          v-if="showGroupHeaders"
          class="px-0.5 text-[11px] font-medium uppercase tracking-wide text-dim2"
          :data-testid="`automation-group-${section.key}`"
        >
          {{ section.label }} · {{ section.items.length }}
        </h2>

        <article
          v-for="task in section.items"
          :key="task.id"
          class="flex flex-col rounded-[14px] border border-line bg-panel p-3.5"
          :class="{ 'opacity-60': !task.enabled }"
        >
          <div class="flex items-center gap-3">
            <span
              class="grid size-8 shrink-0 place-items-center rounded-[9px]"
              :class="
                taskType(task) === 'once'
                  ? 'bg-amber/10 text-amber'
                  : taskType(task) === 'cron'
                    ? 'bg-cyan/10 text-cyan'
                    : 'bg-panel-2 text-dim'
              "
            >
              <Icon :name="typeIcon(task)" :size="16" />
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
                <span
                  v-if="lastResult(task.id)"
                  class="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px]"
                  :class="lastResult(task.id)!.status === 'success' ? 'text-mint' : 'text-orange'"
                  :data-testid="`automation-last-result-${task.id}`"
                >
                  <Icon :name="lastResult(task.id)!.status === 'success' ? 'check-one' : 'close-one'" :size="10" />
                  {{ lastResult(task.id)!.status === "success" ? t("automation.runSuccess") : t("automation.runFailed") }}
                </span>
              </div>
              <div class="mt-0.5 truncate text-[11px] text-dim2">{{ task.intent }}</div>
              <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-dim2">
                <span class="flex items-center gap-1" :data-testid="`automation-next-${task.id}`">
                  <Icon name="clock" :size="10" />
                  {{ nextRunAt(task) ? t("automation.nextRun", { next: fmtDateTime(nextRunAt(task)!) }) : t("automation.nextRunNone") }}
                </span>
                <span>{{ t("automation.lastRun", { last: fmtLastRun(task.lastRun) }) }}</span>
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
                <Hint :text="t('automation.runHistory')">
                  <button
                    type="button"
                    class="grid size-7 cursor-pointer place-items-center rounded-[8px] transition-colors hover:bg-panel-2"
                    :class="expandedId === task.id ? 'text-foreground' : 'text-dim2 hover:text-foreground'"
                    :aria-label="t('automation.runHistory')"
                    :aria-expanded="expandedId === task.id"
                    :data-testid="`automation-history-toggle-${task.id}`"
                    @click="toggleHistory(task.id)"
                  >
                    <Icon name="history" :size="13" />
                  </button>
                </Hint>
                <Hint :text="t('automation.editName')">
                  <button
                    type="button"
                    class="grid size-7 cursor-pointer place-items-center rounded-[8px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground"
                    :aria-label="t('automation.editName')"
                    data-testid="automation-edit"
                    @click="editingId = task.id"
                  >
                    <Icon name="edit" :size="13" />
                  </button>
                </Hint>
                <button
                  class="flex h-7 cursor-pointer items-center gap-1 rounded-[8px] border border-line bg-panel px-2.5 text-[11px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="task.running || automation.list.some((a) => a.running)"
                  @click="runNow(task.id, task.name)"
                >
                  <Icon name="lightning" :size="12" />
                  {{ task.running ? t("automation.running") : t("automation.runNow") }}
                </button>
                <Hint :text="task.enabled ? t('automation.disable') : t('automation.enable')">
                  <button
                    class="grid size-7 cursor-pointer place-items-center rounded-[8px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground"
                    :aria-label="task.enabled ? t('automation.disable') : t('automation.enable')"
                    @click="automation.setEnabled(task.id, !task.enabled)"
                  >
                    <Icon :name="task.enabled ? 'check-one' : 'close-one'" :size="14" />
                  </button>
                </Hint>
                <Hint :text="t('automation.remove')">
                  <button
                    class="grid size-7 cursor-pointer place-items-center rounded-[8px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground"
                    :aria-label="t('automation.remove')"
                    @click="pendingDeleteId = task.id"
                  >
                    <Icon name="delete" :size="14" />
                  </button>
                </Hint>
              </template>
            </div>
          </div>

          <!-- 运行记录（展开）：近 5 次，成功/失败色点 + 时刻 + 后端 + 会话入口 -->
          <div
            v-if="expandedId === task.id"
            class="mt-3 flex flex-col gap-1.5 border-t border-line pt-3"
            :data-testid="`automation-history-${task.id}`"
          >
            <p v-if="runsFor(task.id).length === 0" class="text-[11px] text-dim2">{{ t("automation.runHistoryEmpty") }}</p>
            <div v-for="run in runsFor(task.id).slice(0, 5)" :key="run.id" class="flex items-center gap-2 text-[11px]">
              <span class="size-1.5 shrink-0 rounded-full" :class="run.status === 'success' ? 'bg-mint' : 'bg-orange'" aria-hidden="true" />
              <span class="shrink-0 tabular-nums text-dim2">{{ fmtDateTime(run.ranAt) }}</span>
              <span class="shrink-0 rounded-full bg-panel-2 px-1.5 py-0.5 text-[10px] text-dim2">{{ modeLabel(run.mode) }}</span>
              <span class="min-w-0 flex-1 truncate text-dim" :title="run.detail ?? ''">{{ run.detail ?? "" }}</span>
              <button
                v-if="run.sessionId"
                type="button"
                class="flex shrink-0 cursor-pointer items-center gap-1 rounded-[7px] px-1.5 py-0.5 text-[10.5px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground"
                @click="openSession(run.sessionId)"
              >
                {{ t("automation.openConversation") }}
                <Icon name="external" :size="10" />
              </button>
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
      </div>

      <!-- 过滤后无结果（但确有任务） -->
      <div
        v-if="automation.list.length > 0 && visible.length === 0"
        class="rounded-[14px] border border-dashed border-line-2 bg-panel py-10 text-center text-[12px] text-dim2"
        data-testid="automation-filter-empty"
      >
        {{ t("automation.filterEmpty") }}
      </div>

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
