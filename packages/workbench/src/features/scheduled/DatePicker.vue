<script setup lang="ts">
/**
 * 日期选择器：Popover + shadcn Calendar（reka-ui CalendarRoot，键盘导航由它保证）。
 *
 * 对外契约刻意用原生 `Date`（本地时区当天 00:00）而不是 reka 的 DateValue：
 * 排期领域在 `lib/cron` 里是纯数字，不该把 UI 库的类型漏进 store 与任务模型。
 * 组件内做一次双向换算，`@internationalized/date` 只出现在这一个文件里。
 */
import { computed, ref } from "vue";
import { CalendarDate, type DateValue } from "@internationalized/date";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import Icon from "@/features/shared/Icon.vue";
import { i18n } from "@/i18n";

const props = withDefaults(
  defineProps<{
    /** 已选日期（本地时区当天）；null = 未选。 */
    modelValue: Date | null;
    /** 可选范围（含端点）；null = 不限制。 */
    min?: Date | null;
    max?: Date | null;
    /** 未选时的占位文案。 */
    placeholder?: string;
    /** 触发器文案覆盖（「每月 15 日」这类规则文案）；缺省显示所选日期本身。 */
    label?: string;
    /** 触发行 testid；弹层内部件由它派生（`-prev` / `-next` / `-day-<n>`）。 */
    testId: string;
    disabled?: boolean;
    /** 触发器宽度铺满所属容器（编辑器里与其它字段对齐）。 */
    block?: boolean;
  }>(),
  { min: null, max: null, placeholder: undefined, label: undefined, disabled: false, block: false },
);

const emit = defineEmits<{ "update:modelValue": [value: Date] }>();

const t = i18n.global.t;
const open = ref(false);

/** 本地日期 → CalendarDate（只取年月日，时区不留尾巴）。 */
function toCalendarDate(value: Date): CalendarDate {
  return new CalendarDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
}

const selected = computed<DateValue | undefined>(() => (props.modelValue ? toCalendarDate(props.modelValue) : undefined));
const minValue = computed<DateValue | undefined>(() => (props.min ? toCalendarDate(props.min) : undefined));
const maxValue = computed<DateValue | undefined>(() => (props.max ? toCalendarDate(props.max) : undefined));
/** 展开时的基准月：优先已选日期，否则今天（不传会在 100 年后开窗）。 */
const viewAnchor = computed<DateValue>(() => (props.modelValue ? toCalendarDate(props.modelValue) : toCalendarDate(new Date())));
const locale = computed(() => i18n.global.locale.value);

const label = computed(() => {
  if (props.label) return props.label;
  if (!props.modelValue) return props.placeholder ?? t("automation.schedule.pickDate");
  return props.modelValue.toLocaleDateString(locale.value, { year: "numeric", month: "2-digit", day: "2-digit" });
});

function onPick(value: DateValue | undefined): void {
  if (!value) return;
  emit("update:modelValue", new Date(value.year, value.month - 1, value.day));
  // 选完即收：编辑器里日期与时间是两个相邻控件，留着弹层会挡住时间那一行。
  open.value = false;
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        :data-testid="props.testId"
        :disabled="props.disabled"
        :aria-label="label"
        class="flex h-7 cursor-pointer items-center gap-1.5 rounded-[8px] border border-line bg-panel px-2 text-[11.5px] text-foreground outline-none transition-colors hover:border-line-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
        :class="[props.block ? 'w-full' : '', props.modelValue ? '' : 'text-dim2', open ? 'border-line-2 bg-panel-2' : '']"
      >
        <Icon name="calendar" :size="12" class="shrink-0 text-dim2" />
        <span class="min-w-0 flex-1 truncate text-left">{{ label }}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-auto border-line bg-panel p-0 shadow-xl" :data-testid="`${props.testId}-popover`">
      <!-- Calendar 是 fragment 根（heading + 网格），非 props 属性传不进去，故用一层 div 挂 testid -->
      <div :data-testid="`${props.testId}-calendar`">
        <Calendar
          layout="month-and-year"
          :locale="locale"
          :model-value="selected"
          :min-value="minValue"
          :max-value="maxValue"
          :default-placeholder="viewAnchor"
          class="w-[236px] p-2"
          :class="[
            '[&_[data-slot=calendar-head-cell]]:text-[10.5px] [&_[data-slot=calendar-head-cell]]:text-dim2',
            '[&_[data-slot=calendar-cell-trigger]]:size-7 [&_[data-slot=calendar-cell-trigger]]:text-[11.5px]',
            '[&_[data-slot=calendar-grid]]:space-x-0',
          ]"
          @update:model-value="onPick"
        />
      </div>
    </PopoverContent>
  </Popover>
</template>
