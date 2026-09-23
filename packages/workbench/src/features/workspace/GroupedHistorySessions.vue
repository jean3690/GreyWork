<script setup lang="ts">
import { computed } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import { deviceTier } from "@/lib/device-tier";
import GroupedHistoryRow from "@/features/workspace/GroupedHistoryRow.vue";

/**
 * 单个工作区展开体里的会话列表。
 *
 * 会话数量 > VIRTUAL_THRESHOLD 时切成虚拟窗口渲染：行高恒定（34px + 2px 间距），
 * 不需要像聊天消息那样动态测量，只挂载可视窗口 ± overscan 的行。虚拟行是绝对定位
 * 在「固定总高的相对容器」里的，外层仍是 GroupedHistory 那一个滚动容器 ——
 * 滚动条只有一条，不引入内层滚动。
 *
 * 低端设备（lib/device-tier.ts）：阈值减半、overscan 收到 3，减少同时挂载的行数。
 */
const VIRTUAL_THRESHOLD = computed(() => (deviceTier.value === "low" ? 30 : 60));
/** 行步长：34px 行高 + 2px 间距（与普通路径的 flex gap-0.5 对齐）。 */
const ROW_STRIDE = 36;

const props = defineProps<{
  sessions: { id: string; title: string; updatedAt: number }[];
  activeSessionId: string | null;
  /** 外层滚动容器（GroupedHistory 的滚动区）；虚拟窗口的滚动位置跟随它。 */
  scrollElement: HTMLElement | null;
  /** 挂载后自增一次：父组件模板 ref 晚于首次渲染，需要这一脚触发 options 重算。 */
  scrollTick: number;
}>();

const emit = defineEmits<{ navigate: [path: string] }>();

const virtual = computed(() => props.sessions.length > VIRTUAL_THRESHOLD.value);

/** count 随会话数变化；不足阈值时计 0（实例常驻，但什么都不渲染）。
 *  getScrollElement 里读 scrollTick：它是父组件挂载后自增的哨兵，只有父 ref 就位后
 *  options 才会带真元素重算一次 —— 模板 ref 赋值不触发渲染，prop 首帧恒为 null。 */
const virtualOptions = computed(() => ({
  getScrollElement: () => (props.scrollTick >= 0 ? props.scrollElement : null),
  count: virtual.value ? props.sessions.length : 0,
  // 首帧视口：RO 就位前先按它渲染窗口，避免空首屏（测试环境无布局时也靠它出内容）
  initialRect: { top: 0, left: 0, width: 300, height: 600 },
  estimateSize: () => ROW_STRIDE,
  overscan: deviceTier.value === "low" ? 3 : 8,
  getItemKey: (index: number) => props.sessions[index]?.id ?? index,
}));
const virtualizer = useVirtualizer(virtualOptions);

const totalHeight = computed(() => (virtual.value ? virtualizer.value.getTotalSize() : 0));
</script>

<template>
  <!-- 展开空工作区：就地说明 -->
  <p v-if="!sessions.length" class="px-2 pb-1 text-[11px] text-dim2">暂无会话</p>

  <!-- 少量会话：普通整列渲染 -->
  <div v-else-if="!virtual" class="flex flex-col gap-0.5">
    <GroupedHistoryRow
      v-for="session in sessions"
      :key="session.id"
      :session="session"
      :active="session.id === activeSessionId"
      @navigate="emit('navigate', $event)"
    />
  </div>

  <!-- 大量会话：虚拟窗口（行高恒定，挂载可视窗口 ± overscan） -->
  <div v-else class="relative" :style="{ height: `${totalHeight}px` }">
    <div
      v-for="row in virtualizer.getVirtualItems()"
      :key="String(row.key)"
      :data-index="row.index"
      class="absolute left-0 top-0 w-full"
      :style="{ transform: `translateY(${row.start}px)` }"
    >
      <GroupedHistoryRow
        :session="sessions[row.index]"
        :active="sessions[row.index].id === activeSessionId"
        @navigate="emit('navigate', $event)"
      />
    </div>
  </div>
</template>
