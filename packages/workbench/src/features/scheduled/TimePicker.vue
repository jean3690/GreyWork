<script setup lang="ts">
/**
 * 时间选择器：Popover + 两列滚轮（时 / 分），对外契约是 `HH:MM` 字符串。
 *
 * 为什么不用原生 `<input type="time">`：它的外观由平台决定（Windows/macOS/Linux
 * 三种面孔），且只给键盘输入；排期面板里时间是与日期并列的一等字段，样式要和
 * 其余控件同族。两列按钮列表点一下就改，Esc / 点外部关闭由 Popover 兜底。
 *
 * 分钟粒度 1 分：cron 本来就是分钟精度，这里做 5 分步进会让「09:03」这类已存
 * 任务选不回去。
 */
import { computed, ref, watch } from "vue";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import Icon from "@/features/shared/Icon.vue";
import { i18n } from "@/i18n";

const t = i18n.global.t;

const props = withDefaults(
  defineProps<{
    /** `HH:MM`（24 小时制）。非法/缺省时展示 `00:00` 视图。 */
    modelValue: string;
    testId: string;
    disabled?: boolean;
  }>(),
  { disabled: false },
);

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const HOURS = Array.from({ length: 24 }, (_, index) => index);
const MINUTES = Array.from({ length: 60 }, (_, index) => index);

const open = ref(false);

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** `HH:MM` → 组件；缺失/非法时回落 00:00（输入源已受控，这里是防御）。 */
const parsed = computed(() => {
  const [rawHour, rawMinute] = props.modelValue.split(":");
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return { hour: 0, minute: 0 };
  }
  return { hour, minute };
});

const label = computed(() => `${pad2(parsed.value.hour)}:${pad2(parsed.value.minute)}`);

function setHour(hour: number): void {
  emit("update:modelValue", `${pad2(hour)}:${pad2(parsed.value.minute)}`);
}

function setMinute(minute: number): void {
  emit("update:modelValue", `${pad2(parsed.value.hour)}:${pad2(minute)}`);
}

/** 打开时把选中项滚进视野（列表高 132px，选中的 18 分钟在视口外就看不见了）。 */
const hourColumn = ref<HTMLElement | null>(null);
const minuteColumn = ref<HTMLElement | null>(null);

function scrollColumnIntoView(column: HTMLElement | null, testId: string): void {
  column?.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.scrollIntoView({ block: "center" });
}

watch(open, (next) => {
  if (!next) return;
  // 等 Popover 把内容挂进 DOM 之后再滚。
  requestAnimationFrame(() => {
    scrollColumnIntoView(hourColumn.value, `${props.testId}-hour-${parsed.value.hour}`);
    scrollColumnIntoView(minuteColumn.value, `${props.testId}-minute-${parsed.value.minute}`);
  });
});

/** 「现在」把两个列一起改：只改一半会留下一个用户没打算要的时刻。 */
function setNow(): void {
  const now = new Date();
  emit("update:modelValue", `${pad2(now.getHours())}:${pad2(now.getMinutes())}`);
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
        class="flex h-7 cursor-pointer items-center gap-1.5 rounded-[8px] border border-line bg-panel px-2 font-mono text-[11.5px] text-foreground outline-none transition-colors hover:border-line-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
        :class="open ? 'border-line-2 bg-panel-2' : ''"
      >
        <Icon name="clock" :size="12" class="shrink-0 text-dim2" />
        <span>{{ label }}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-auto border-line bg-panel p-0 shadow-xl" :data-testid="`${props.testId}-popover`">
      <div class="flex items-stretch gap-0.5 p-1.5">
        <div
          ref="hourColumn"
          class="flex max-h-[132px] w-11 flex-col overflow-y-auto scroll-smooth"
          :aria-label="t('automation.time.hour')"
        >
          <button
            v-for="hour in HOURS"
            :key="hour"
            type="button"
            :data-testid="`${props.testId}-hour-${hour}`"
            class="h-6 shrink-0 cursor-pointer rounded-[6px] font-mono text-[11.5px] transition-colors"
            :class="hour === parsed.hour ? 'bg-secondary text-foreground' : 'text-dim hover:bg-panel-2 hover:text-foreground'"
            :aria-pressed="hour === parsed.hour"
            @click="setHour(hour)"
          >
            {{ pad2(hour) }}
          </button>
        </div>
        <span class="flex items-center font-mono text-[11.5px] text-dim2">:</span>
        <div
          ref="minuteColumn"
          class="flex max-h-[132px] w-11 flex-col overflow-y-auto scroll-smooth"
          :aria-label="t('automation.time.minute')"
        >
          <button
            v-for="minute in MINUTES"
            :key="minute"
            type="button"
            :data-testid="`${props.testId}-minute-${minute}`"
            class="h-6 shrink-0 cursor-pointer rounded-[6px] font-mono text-[11.5px] transition-colors"
            :class="minute === parsed.minute ? 'bg-secondary text-foreground' : 'text-dim hover:bg-panel-2 hover:text-foreground'"
            :aria-pressed="minute === parsed.minute"
            @click="setMinute(minute)"
          >
            {{ pad2(minute) }}
          </button>
        </div>
      </div>
      <div class="flex items-center justify-between gap-2 border-t border-line px-2 py-1.5">
        <button
          type="button"
          class="h-6 cursor-pointer rounded-[6px] border border-line px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
          :data-testid="`${props.testId}-now`"
          @click="setNow"
        >
          {{ t("automation.time.now") }}
        </button>
        <button
          type="button"
          class="h-6 cursor-pointer rounded-[6px] bg-accent px-2.5 text-[11px] font-medium text-accent-ink transition-opacity hover:opacity-90"
          :data-testid="`${props.testId}-done`"
          @click="open = false"
        >
          {{ t("automation.time.done") }}
        </button>
      </div>
    </PopoverContent>
  </Popover>
</template>
