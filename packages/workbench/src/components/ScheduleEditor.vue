<script setup lang="ts">
import { computed, ref } from "vue";
import { i18n } from "../i18n";
import { useAgentStore } from "../stores/agent";
import { composeCron, decomposeCron, describeCron, nextCronRuns, validateCron, type ScheduleSpec } from "../lib/cron";

/**
 * 定时任务编辑器（行内展开面板）：任务名 / 指令 / 执行后端（ACP 或本机模型）/
 * 触发时间（选时间或写 cron）。
 *
 * 设计要点：
 * - `cron` 是唯一排期真源：结构化输入（每天 / 每周 / 每月 / 间隔）与自定义表达式
 *   都归一到 5 段表达式再落库；`schedule`（人类可读描述）由表达式反推，仅作展示。
 * - 无 cron = 手动触发（只 Run Now），不是「无效」状态，故保存按钮按模式分别判定。
 * - 表达式非法时不落库也不猜：就地显示错误 + 保留原文（改坏别人的表达式比拒绝保存更糟）。
 * - 初始草稿在 setup 期从 props 反解一次；组件按 task.id 重挂载，编辑态不跨任务串味。
 */
const props = defineProps<{
  name: string;
  intent: string;
  acpProviderId: string | null;
  cron: string | null;
}>();

const emit = defineEmits<{
  save: [patch: { name: string; intent: string; acpProviderId: string | null; cron: string | null; schedule: string }];
  cancel: [];
}>();

const t = i18n.global.t;
const agent = useAgentStore();

type ScheduleMode = ScheduleSpec["kind"];

/** 星期选择顺序：周一 → 周日（值仍是标准 cron 语义，0 = 周日）。 */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

const initial = decomposeCron(props.cron);

const name = ref(props.name);
const intent = ref(props.intent);
const acpProviderId = ref(props.acpProviderId ?? "");
const mode = ref<ScheduleMode>(initial.kind);
const time = ref(
  initial.kind === "daily" || initial.kind === "weekly" || initial.kind === "monthly"
    ? `${pad2(initial.hour)}:${pad2(initial.minute)}`
    : "09:00",
);
const weeklyDays = ref<number[]>(initial.kind === "weekly" ? [...initial.days] : [1]);
const monthDay = ref(initial.kind === "monthly" ? initial.day : 1);
const intervalUnit = ref<"minute" | "hour">(initial.kind === "interval" ? initial.unit : "minute");
const intervalEvery = ref(initial.kind === "interval" ? initial.every : 15);
const cronText = ref(initial.kind === "cron" ? initial.expr : (props.cron ?? ""));

const MODES = computed<{ id: ScheduleMode; label: string }[]>(() => [
  { id: "manual", label: t("automation.schedule.manual") },
  { id: "daily", label: t("automation.schedule.daily") },
  { id: "weekly", label: t("automation.schedule.weekly") },
  { id: "monthly", label: t("automation.schedule.monthly") },
  { id: "interval", label: t("automation.schedule.interval") },
  { id: "cron", label: t("automation.schedule.custom") },
]);

const providerOptions = computed(() =>
  agent.agentProviders.map((provider) => ({
    id: provider.id,
    label: provider.enabled ? provider.name : t("automation.schedule.acpDisabled", { name: provider.name }),
  })),
);

/** `HH:MM`（原生 time 输入）→ 组件；缺失/非法时回落 09:00（输入框已约束，防御用）。 */
const parsedTime = computed(() => {
  const [hour, minute] = time.value.split(":");
  const parsedHour = Number(hour);
  const parsedMinute = Number(minute);
  if (!Number.isInteger(parsedHour) || !Number.isInteger(parsedMinute)) return { hour: 9, minute: 0 };
  return { hour: parsedHour, minute: parsedMinute };
});

const currentSpec = computed<ScheduleSpec>(() => {
  switch (mode.value) {
    case "manual":
      return { kind: "manual" };
    case "daily":
      return { kind: "daily", ...parsedTime.value };
    case "weekly":
      return { kind: "weekly", days: weeklyDays.value, ...parsedTime.value };
    case "monthly":
      return { kind: "monthly", day: monthDay.value, ...parsedTime.value };
    case "interval":
      return { kind: "interval", unit: intervalUnit.value, every: intervalEvery.value };
    case "cron":
      return { kind: "cron", expr: cronText.value };
  }
});

/** 归一后的表达式；null = 手动触发或结构化输入不完整（如一个星期都没选）。 */
const cronExpression = computed(() => composeCron(currentSpec.value));
const cronError = computed(() => (cronExpression.value === null ? null : validateCron(cronExpression.value)));
const errorText = computed(() => {
  const error = cronError.value;
  if (!error) return "";
  const params = { ...error, field: error.field ? t(`automation.cron.field.${error.field}`) : "" };
  return t(`automation.cron.${error.messageKey}`, params);
});
const description = computed(() => (cronExpression.value === null ? null : (describeCron(cronExpression.value) ?? cronExpression.value)));

const nextRuns = computed(() =>
  cronExpression.value === null || cronError.value !== null ? [] : nextCronRuns(cronExpression.value, new Date(), 3),
);
const nextRunsText = computed(() =>
  nextRuns.value.length > 0
    ? nextRuns.value
        .map((run) =>
          run.toLocaleString(i18n.global.locale.value, {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }),
        )
        .join(" · ")
    : "",
);

const canSave = computed(
  () => intent.value.trim() !== "" && (mode.value === "manual" || (cronExpression.value !== null && cronError.value === null)),
);

function toggleDay(day: number): void {
  weeklyDays.value = weeklyDays.value.includes(day) ? weeklyDays.value.filter((value) => value !== day) : [...weeklyDays.value, day];
}

/** 间隔数值约束在字段值域内（步进 > 字段上限只会退化成「每整点」，没有意义）。 */
function clampEvery(): void {
  const max = intervalUnit.value === "minute" ? 59 : 23;
  const parsed = Math.round(Number(intervalEvery.value));
  intervalEvery.value = Number.isFinite(parsed) ? Math.min(max, Math.max(1, parsed)) : 1;
}

function save(): void {
  if (!canSave.value) return;
  const expr = cronExpression.value;
  emit("save", {
    name: name.value.trim() || t("automation.namePlaceholder"),
    intent: intent.value.trim(),
    acpProviderId: acpProviderId.value === "" ? null : acpProviderId.value,
    cron: expr,
    schedule: expr === null ? t("automation.manualTrigger") : (description.value ?? expr),
  });
}
</script>

<template>
  <div class="mt-3 flex flex-col gap-2.5 border-t border-line pt-3" data-testid="schedule-editor">
    <input
      v-model="name"
      class="rounded-[8px] border border-line bg-panel px-2 py-1.5 text-[13px] text-foreground outline-none focus:border-line-2"
      :placeholder="t('automation.namePlaceholder')"
      :aria-label="t('automation.namePlaceholder')"
      data-testid="schedule-name"
    />
    <input
      v-model="intent"
      class="rounded-[8px] border border-line bg-panel px-2 py-1.5 text-[11.5px] text-foreground outline-none focus:border-line-2"
      :placeholder="t('automation.intentPlaceholder')"
      :aria-label="t('automation.intentPlaceholder')"
      data-testid="schedule-intent"
    />

    <label class="flex items-center gap-2">
      <span class="w-16 shrink-0 text-[11.5px] text-dim2">{{ t("automation.schedule.acp") }}</span>
      <select
        v-model="acpProviderId"
        class="min-w-0 flex-1 cursor-pointer rounded-[8px] border border-line bg-panel-2 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-line-2"
        data-testid="schedule-acp"
      >
        <option value="">{{ t("automation.schedule.acpLlm") }}</option>
        <option v-for="provider in providerOptions" :key="provider.id" :value="provider.id">{{ provider.label }}</option>
      </select>
    </label>
    <p class="text-[10.5px] leading-relaxed text-dim2">{{ t("automation.schedule.acpHint") }}</p>

    <div class="flex flex-wrap gap-1">
      <button
        v-for="option in MODES"
        :key="option.id"
        type="button"
        class="h-7 cursor-pointer rounded-[7px] border px-2.5 text-[11.5px] transition-colors"
        :class="
          mode === option.id
            ? 'border-accent bg-panel-2 text-foreground'
            : 'border-line bg-panel-2 text-dim hover:border-line-2 hover:text-foreground'
        "
        :aria-pressed="mode === option.id"
        :data-testid="`schedule-mode-${option.id}`"
        @click="mode = option.id"
      >
        {{ option.label }}
      </button>
    </div>

    <div v-if="mode === 'daily' || mode === 'weekly' || mode === 'monthly'" class="flex flex-wrap items-center gap-2">
      <template v-if="mode === 'weekly'">
        <span class="text-[11.5px] text-dim2">{{ t("automation.schedule.weekdays") }}</span>
        <button
          v-for="day in WEEKDAY_ORDER"
          :key="day"
          type="button"
          class="size-7 cursor-pointer rounded-[7px] border text-[11px] transition-colors"
          :class="
            weeklyDays.includes(day)
              ? 'border-accent bg-panel-2 text-foreground'
              : 'border-line bg-panel text-dim hover:border-line-2 hover:text-foreground'
          "
          :aria-pressed="weeklyDays.includes(day)"
          :data-testid="`schedule-weekday-${day}`"
          @click="toggleDay(day)"
        >
          {{ t(`automation.cron.weekdayShort.${day}`) }}
        </button>
      </template>
      <template v-if="mode === 'monthly'">
        <span class="text-[11.5px] text-dim2">{{ t("automation.schedule.monthDay") }}</span>
        <input
          v-model.number="monthDay"
          type="number"
          min="1"
          max="31"
          class="w-16 rounded-[8px] border border-line bg-panel px-2 py-1 text-[11.5px] text-foreground outline-none focus:border-line-2"
          data-testid="schedule-month-day"
        />
      </template>
      <span class="text-[11.5px] text-dim2">{{ t("automation.schedule.time") }}</span>
      <input
        v-model="time"
        type="time"
        class="rounded-[8px] border border-line bg-panel px-2 py-1 text-[11.5px] text-foreground outline-none focus:border-line-2"
        data-testid="schedule-time"
      />
    </div>

    <div v-else-if="mode === 'interval'" class="flex items-center gap-2">
      <span class="text-[11.5px] text-dim2">{{ t("automation.schedule.every") }}</span>
      <input
        v-model.number="intervalEvery"
        type="number"
        min="1"
        :max="intervalUnit === 'minute' ? 59 : 23"
        class="w-16 rounded-[8px] border border-line bg-panel px-2 py-1 text-[11.5px] text-foreground outline-none focus:border-line-2"
        data-testid="schedule-every"
        @blur="clampEvery"
      />
      <select
        v-model="intervalUnit"
        class="cursor-pointer rounded-[8px] border border-line bg-panel-2 px-2 py-1 text-[11.5px] text-foreground outline-none focus:border-line-2"
        data-testid="schedule-unit"
        @change="clampEvery"
      >
        <option value="minute">{{ t("automation.schedule.unitMinute") }}</option>
        <option value="hour">{{ t("automation.schedule.unitHour") }}</option>
      </select>
    </div>

    <div v-else-if="mode === 'cron'" class="flex flex-col gap-1">
      <input
        v-model="cronText"
        spellcheck="false"
        class="rounded-[8px] border border-line bg-panel px-2 py-1.5 font-mono text-[12px] text-foreground outline-none focus:border-line-2"
        :placeholder="t('automation.schedule.cronPlaceholder')"
        data-testid="schedule-cron-input"
      />
      <p class="text-[10.5px] leading-relaxed text-dim2">{{ t("automation.schedule.cronHint") }}</p>
    </div>

    <div class="rounded-[10px] border border-line bg-panel-2 px-2.5 py-2 text-[11px] leading-relaxed">
      <p v-if="mode === 'manual'" class="text-dim2">{{ t("automation.schedule.manual") }}</p>
      <template v-else>
        <p v-if="cronError" class="text-destructive" data-testid="schedule-error">{{ errorText }}</p>
        <p v-else-if="cronExpression === null" class="text-destructive" data-testid="schedule-error">
          {{ t("automation.schedule.pickWeekday") }}
        </p>
        <p v-else class="flex items-center gap-2 text-foreground">
          <span data-testid="schedule-description">{{ description }}</span>
          <code class="shrink-0 rounded-[5px] bg-panel px-1.5 py-0.5 font-mono text-[10.5px] text-dim2" data-testid="schedule-cron">
            {{ cronExpression }}
          </code>
        </p>
        <p v-if="cronExpression !== null && !cronError" class="mt-0.5 text-dim2" data-testid="schedule-next">
          {{ nextRunsText ? t("automation.schedule.nextRuns", { runs: nextRunsText }) : t("automation.schedule.neverFires") }}
        </p>
      </template>
    </div>

    <div class="flex items-center gap-2">
      <button
        type="button"
        class="h-7 cursor-pointer rounded-[8px] border px-2.5 text-[11.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        :class="canSave ? 'border-accent bg-panel-2 text-foreground' : 'border-line bg-panel-2 text-dim'"
        :disabled="!canSave"
        data-testid="schedule-save"
        @click="save"
      >
        {{ t("common.saveAction") }}
      </button>
      <button
        type="button"
        class="h-7 cursor-pointer rounded-[8px] border border-line bg-panel px-2.5 text-[11.5px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
        data-testid="schedule-cancel"
        @click="emit('cancel')"
      >
        {{ t("common.cancel") }}
      </button>
      <span v-if="intent.trim() === ''" class="text-[10.5px] text-dim2">{{ t("automation.schedule.needIntent") }}</span>
    </div>
  </div>
</template>
