<script setup lang="ts">
import { computed, ref } from "vue";
import { i18n } from "@/i18n";
import { useAgentStore } from "@/stores/agent";
import { composeCron, decomposeCron, describeCron, nextCronRuns, validateCron, type ScheduleSpec } from "@/lib/cron";
import DatePicker from "@/features/scheduled/DatePicker.vue";
import TimePicker from "@/features/scheduled/TimePicker.vue";

/**
 * 定时任务编辑器（行内展开面板）：任务名 / 指令 / 执行后端（ACP 或本机模型）/
 * 触发时间（日历 + 时间选择器，或写 cron）。
 *
 * 设计要点：
 * - `cron` 是循环排期的真源、`onceAt` 是一次性任务的真源：结构化输入（每天 / 每周 /
 *   每月 / 每年 / 间隔）与自定义表达式都归一到 5 段表达式再落库；`schedule`
 *   （人类可读描述）由表达式反推，仅作展示。一次性任务**不写 cron**——cron 没有
 *   年份字段，`m h d mon *` 会被读成「每年这天」，由宿主按 `onceAt` 时间戳判定。
 * - 无 cron 且无 onceAt = 手动触发（只 Run Now），不是「无效」状态，故保存按钮按模式分别判定。
 * - 表达式非法时不落库也不猜：就地显示错误 + 保留原文（改坏别人的表达式比拒绝保存更糟）。
 * - 初始草稿在 setup 期从 props 反解一次；组件按 task.id 重挂载，编辑态不跨任务串味。
 */
const props = defineProps<{
  name: string;
  intent: string;
  acpProviderId: string | null;
  cron: string | null;
  /** 一次性任务的触发时刻（epoch ms）；null = 非一次性。 */
  onceAt: number | null;
}>();

const emit = defineEmits<{
  save: [
    patch: {
      name: string;
      intent: string;
      acpProviderId: string | null;
      cron: string | null;
      onceAt: number | null;
      schedule: string;
    },
  ];
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

/** 时段锚点：日历要显示一个「确实存在这一天」的月份，31 日不能落在 4 月。 */
function anchorForDay(day: number, month = 1): Date {
  const safeDay = Math.min(31, Math.max(1, day));
  if (safeDay <= 28) return new Date(2028, month - 1, safeDay);
  if (safeDay === 29) return new Date(2028, 1, 29); // 2028 是闰年
  if (safeDay === 30) return new Date(2028, 3, 30);
  return new Date(2028, 0, 31);
}

/** 「每月第几天」的日历锚点：从当前月往后找第一个有这一天的月份（31 日不会落到 2 月）。 */
function monthlyAnchor(day: number): Date {
  const safeDay = Math.min(31, Math.max(1, day));
  const now = new Date();
  for (let offset = 0; offset < 12; offset += 1) {
    const candidate = new Date(now.getFullYear(), now.getMonth() + offset, safeDay);
    if (candidate.getDate() === safeDay) return candidate;
  }
  return anchorForDay(safeDay);
}

const initial = decomposeCron(props.cron, props.onceAt);

const name = ref(props.name);
const intent = ref(props.intent);
const acpProviderId = ref(props.acpProviderId ?? "");
const mode = ref<ScheduleMode>(initial.kind);
/** `HH:MM`：所有带时刻的模式共用（切模式不丢用户刚挑的时间）。 */
const time = ref(
  initial.kind === "daily" || initial.kind === "weekly" || initial.kind === "monthly" || initial.kind === "yearly"
    ? `${pad2(initial.hour)}:${pad2(initial.minute)}`
    : initial.kind === "once"
      ? `${pad2(new Date(initial.at).getHours())}:${pad2(new Date(initial.at).getMinutes())}`
      : "09:00",
);
const weeklyDays = ref<number[]>(initial.kind === "weekly" ? [...initial.days] : [1]);
const monthDay = ref(initial.kind === "monthly" ? initial.day : 1);
const yearMonth = ref(initial.kind === "yearly" ? initial.month : 1);
const yearDay = ref(initial.kind === "yearly" ? initial.day : 1);
const intervalUnit = ref<"minute" | "hour">(initial.kind === "interval" ? initial.unit : "minute");
const intervalEvery = ref(initial.kind === "interval" ? initial.every : 15);
const cronText = ref(initial.kind === "cron" ? initial.expr : (props.cron ?? ""));
/** 一次性任务的日期（本地日历日，00:00）；null = 还没挑。 */
const onceDate = ref<Date | null>(initial.kind === "once" ? new Date(new Date(initial.at).setHours(0, 0, 0, 0)) : null);
/** 日历锚点（展示用）：每月按「第几天」找有该日的月份，每年固定到 2028 展示月/日。 */
const monthAnchor = ref(monthlyAnchor(monthDay.value));
const yearAnchor = ref(anchorForDay(yearDay.value, yearMonth.value));

const MODES = computed<{ id: ScheduleMode; label: string }[]>(() => [
  { id: "manual", label: t("automation.schedule.manual") },
  { id: "once", label: t("automation.schedule.once") },
  { id: "daily", label: t("automation.schedule.daily") },
  { id: "weekly", label: t("automation.schedule.weekly") },
  { id: "monthly", label: t("automation.schedule.monthly") },
  { id: "yearly", label: t("automation.schedule.yearly") },
  { id: "interval", label: t("automation.schedule.interval") },
  { id: "cron", label: t("automation.schedule.custom") },
]);

const providerOptions = computed(() =>
  agent.agentProviders.map((provider) => ({
    id: provider.id,
    label: provider.enabled ? provider.name : t("automation.schedule.acpDisabled", { name: provider.name }),
  })),
);

/** `HH:MM`（选择器已约束）→ 组件；缺失/非法时回落 09:00（防御用）。 */
const parsedTime = computed(() => {
  const [hour, minute] = time.value.split(":");
  const parsedHour = Number(hour);
  const parsedMinute = Number(minute);
  if (!Number.isInteger(parsedHour) || !Number.isInteger(parsedMinute)) return { hour: 9, minute: 0 };
  return { hour: parsedHour, minute: parsedMinute };
});

/** 一次性任务的触发时刻：日期 × 时间；日期未选 → null（名字避开 prop `onceAt`）。 */
const onceInstant = computed<number | null>(() => {
  if (mode.value !== "once" || !onceDate.value) return null;
  return new Date(
    onceDate.value.getFullYear(),
    onceDate.value.getMonth(),
    onceDate.value.getDate(),
    parsedTime.value.hour,
    parsedTime.value.minute,
    0,
    0,
  ).getTime();
});
/** 过去时刻不落库：宿主入队后只会立刻补跑一次（还留着 lastRun=0 的假象）。 */
const onceInPast = computed(() => mode.value === "once" && onceInstant.value !== null && onceInstant.value <= Date.now());

const currentSpec = computed<ScheduleSpec>(() => {
  switch (mode.value) {
    case "manual":
      return { kind: "manual" };
    case "once":
      return { kind: "once", at: onceInstant.value ?? 0 };
    case "daily":
      return { kind: "daily", ...parsedTime.value };
    case "weekly":
      return { kind: "weekly", days: weeklyDays.value, ...parsedTime.value };
    case "monthly":
      return { kind: "monthly", day: monthDay.value, ...parsedTime.value };
    case "yearly":
      return { kind: "yearly", month: yearMonth.value, day: yearDay.value, ...parsedTime.value };
    case "interval":
      return { kind: "interval", unit: intervalUnit.value, every: intervalEvery.value };
    case "cron":
      return { kind: "cron", expr: cronText.value };
  }
});

/** 归一后的表达式；null = 手动触发 / 一次性任务 / 结构化输入不完整（如一个星期都没选）。 */
const cronExpression = computed(() => composeCron(currentSpec.value));
const cronError = computed(() => (cronExpression.value === null ? null : validateCron(cronExpression.value)));
const errorText = computed(() => {
  const error = cronError.value;
  if (!error) return "";
  const params = { ...error, field: error.field ? t(`automation.cron.field.${error.field}`) : "" };
  return t(`automation.cron.${error.messageKey}`, params);
});
const description = computed(() => (cronExpression.value === null ? null : (describeCron(cronExpression.value) ?? cronExpression.value)));

/** 一次性任务的描述（含完整年月日；循环任务的描述由 cron 反推）。 */
const onceDescription = computed(() => {
  const at = onceInstant.value;
  if (at === null) return null;
  return t("automation.schedule.onceAt", {
    date: new Date(at).toLocaleString(i18n.global.locale.value, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
  });
});

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

const canSave = computed(() => {
  if (intent.value.trim() === "") return false;
  if (mode.value === "manual") return true;
  if (mode.value === "once") return onceInstant.value !== null && !onceInPast.value;
  return cronExpression.value !== null && cronError.value === null;
});

/** 间隔数值字段上限：分钟 0-59、小时 0-23（输入框 :max 与 clampEvery 共用同一来源）。 */
const intervalMax = computed(() => (intervalUnit.value === "minute" ? 59 : 23));
const intentMissing = computed(() => intent.value.trim() === "");

function toggleDay(day: number): void {
  weeklyDays.value = weeklyDays.value.includes(day) ? weeklyDays.value.filter((value) => value !== day) : [...weeklyDays.value, day];
}

/** 间隔数值约束在字段值域内（步进 > 字段上限只会退化成「每整点」，没有意义）。 */
function clampEvery(): void {
  const parsed = Math.round(Number(intervalEvery.value));
  intervalEvery.value = Number.isFinite(parsed) ? Math.min(intervalMax.value, Math.max(1, parsed)) : 1;
}

/** 每月第几天：日历点选后只取「日」，锚点跟着选中的日期走（月份/年份不影响规则）。 */
function pickMonthDay(picked: Date): void {
  monthDay.value = picked.getDate();
  monthAnchor.value = picked;
}

/** 每年几月几号：日历点选后取「月 + 日」。 */
function pickYearDay(picked: Date): void {
  yearMonth.value = picked.getMonth() + 1;
  yearDay.value = picked.getDate();
  yearAnchor.value = picked;
}

/** 每月 / 每年触发器的规则文案（日历里的日期只是选择方式，规则本身不看年份）。 */
const monthDayLabel = computed(() => t("automation.schedule.monthlyOn", { day: monthDay.value }));
const yearDayLabel = computed(() => t("automation.schedule.yearlyOn", { month: yearMonth.value, day: yearDay.value }));

function save(): void {
  if (!canSave.value) return;
  const expr = cronExpression.value;
  const once = mode.value === "once" ? onceInstant.value : null;
  emit("save", {
    name: name.value.trim() || t("automation.namePlaceholder"),
    intent: intent.value.trim(),
    acpProviderId: acpProviderId.value === "" ? null : acpProviderId.value,
    cron: expr,
    onceAt: once,
    schedule:
      mode.value === "manual"
        ? t("automation.manualTrigger")
        : mode.value === "once"
          ? (onceDescription.value ?? t("automation.manualTrigger"))
          : (description.value ?? expr ?? t("automation.manualTrigger")),
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

    <!-- 指定日期时间：日历挑日期 + 时间选择器挑时刻，只跑一次 -->
    <div v-if="mode === 'once'" class="flex flex-col gap-1.5">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[11.5px] text-dim2">{{ t("automation.schedule.date") }}</span>
        <DatePicker v-model="onceDate" test-id="schedule-once-date" :min="new Date()" :placeholder="t('automation.schedule.pickDate')" />
        <span class="text-[11.5px] text-dim2">{{ t("automation.schedule.time") }}</span>
        <TimePicker v-model="time" test-id="schedule-once-time" />
      </div>
      <p class="text-[10.5px] leading-relaxed text-dim2">{{ t("automation.schedule.onceHint") }}</p>
    </div>

    <div v-else-if="mode === 'daily' || mode === 'weekly' || mode === 'monthly' || mode === 'yearly'" class="flex flex-col gap-1.5">
      <div class="flex flex-wrap items-center gap-2">
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
          <DatePicker :model-value="monthAnchor" :label="monthDayLabel" test-id="schedule-month-day" @update:model-value="pickMonthDay" />
        </template>
        <template v-if="mode === 'yearly'">
          <span class="text-[11.5px] text-dim2">{{ t("automation.schedule.yearDay") }}</span>
          <DatePicker :model-value="yearAnchor" :label="yearDayLabel" test-id="schedule-year-day" @update:model-value="pickYearDay" />
        </template>
        <span class="text-[11.5px] text-dim2">{{ t("automation.schedule.time") }}</span>
        <TimePicker v-model="time" test-id="schedule-time" />
      </div>
      <p v-if="mode === 'monthly'" class="text-[10.5px] leading-relaxed text-dim2">{{ t("automation.schedule.monthDayHint") }}</p>
      <p v-else-if="mode === 'yearly'" class="text-[10.5px] leading-relaxed text-dim2">{{ t("automation.schedule.yearDayHint") }}</p>
    </div>

    <div v-else-if="mode === 'interval'" class="flex items-center gap-2">
      <span class="text-[11.5px] text-dim2">{{ t("automation.schedule.every") }}</span>
      <input
        v-model.number="intervalEvery"
        type="number"
        min="1"
        :max="intervalMax"
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
      <template v-else-if="mode === 'once'">
        <p v-if="onceDate === null" class="text-destructive" data-testid="schedule-error">
          {{ t("automation.schedule.pickDate") }}
        </p>
        <p v-else-if="onceInPast" class="text-destructive" data-testid="schedule-error">
          {{ t("automation.schedule.onceInPast") }}
        </p>
        <p v-else class="flex items-center gap-2 text-foreground">
          <span data-testid="schedule-description">{{ onceDescription }}</span>
          <span class="shrink-0 rounded-[5px] bg-panel px-1.5 py-0.5 text-[10.5px] text-dim2" data-testid="schedule-once-badge">
            {{ t("automation.onceBadge") }}
          </span>
        </p>
      </template>
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
      <span v-if="intentMissing" class="text-[10.5px] text-dim2">{{ t("automation.schedule.needIntent") }}</span>
    </div>
  </div>
</template>
