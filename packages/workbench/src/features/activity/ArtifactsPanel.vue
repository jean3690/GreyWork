<script setup lang="ts">
/**
 * 底部活动面板「产物」页签内容（core.artifacts 贡献，activity.artifacts）。
 *
 * 数据源是 artifact store 的全局产物列表（newest-first，deliverArtifact 里 unshift），
 * 跨会话汇总。点击名称在右栏预览面板就地打开 —— 主路径与 ArtifactCards 一致；
 * 无 VFS 路径的产物（仅登记未落盘的）按钮禁用，理由与卡片面相同。
 * 空态只占位说明，不塞示例数据（产物只应来自真实运行，见 artifact store 注释）。
 */
import { computed, ref } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import { deviceTier } from "@/lib/device-tier";
import { observeNonZeroRect } from "@/lib/virtual-rect";
import { useArtifactStore } from "@/stores/artifact";
import { usePreviewStore } from "@/stores/preview";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";

const artifactStore = useArtifactStore();
const preview = usePreviewStore();

/* ===== 行虚拟化 =====
 * 产物列表是全局累积的（deliverArtifact 里 unshift），跨会话越攒越多。行高恒定
 * （30px + 2px 间距），超过阈值切成虚拟窗口，只挂载可视窗口 ± overscan。
 * 低端设备（lib/device-tier.ts）：阈值减半、overscan 收到 3。 */
const scrollEl = ref<HTMLElement | null>(null);
const VIRTUAL_THRESHOLD = computed(() => (deviceTier.value === "low" ? 30 : 60));
/** 行步长：30px 行高 + 2px 间距（对齐普通路径的 flex gap-0.5）。 */
const ROW_STRIDE = 32;
const artifacts = computed(() => artifactStore.artifacts);
const virtual = computed(() => artifacts.value.length > VIRTUAL_THRESHOLD.value);
const virtualOptions = computed(() => {
  // 先读一次 ref 再闭包捕获：`getScrollElement` 内部读不算依赖，模板 ref 赋值就不会让这份
  // options 失效。不显式建立依赖的话，virtualizer 会一直拿着首帧的 null 滚动元素。
  const element = scrollEl.value;
  return {
    getScrollElement: () => element,
    // 丢弃 0×0 视口读数：容器刚挂上时还没布局，0 会覆盖 initialRect 让整列算空（见 lib/virtual-rect.ts）。
    observeElementRect: observeNonZeroRect,
    count: virtual.value ? artifacts.value.length : 0,
    // 首帧视口：RO 就位前先按它渲染窗口，避免空首屏（测试环境无布局时也靠它出内容）。
    initialRect: { top: 0, left: 0, width: 300, height: 400 },
    estimateSize: () => ROW_STRIDE,
    overscan: deviceTier.value === "low" ? 3 : 8,
    getItemKey: (index: number) => artifacts.value[index]?.id ?? index,
  };
});
const virtualizer = useVirtualizer(virtualOptions);

/** 一行在容器里的落位；`artifact` 直接带上，模板里不必再按下标回查。 */
interface RowSlot {
  index: number;
  key: string;
  start: number;
  artifact: (typeof artifactStore.artifacts)[number];
}

/** 两条路径产出同一种「绝对定位 + translateY」形状，模板只写一遍。 */
const slots = computed<RowSlot[]>(() => {
  if (!virtual.value) {
    return artifacts.value.map((artifact, index) => ({ index, key: artifact.id, start: index * ROW_STRIDE, artifact }));
  }
  return virtualizer.value.getVirtualItems().map((item) => ({
    index: item.index,
    key: String(item.key),
    start: item.start,
    artifact: artifacts.value[item.index],
  }));
});

/** 容器总高：两条路径都必须显式给，否则绝对定位的行撑不起滚动条。 */
const totalHeight = computed(() => (virtual.value ? virtualizer.value.getTotalSize() : artifacts.value.length * ROW_STRIDE));

/**
 * 在右栏打开产物，并把落盘路径一并挂到 tab 上（预览的「用系统应用打开」据此定位）。
 * 不能塞进 `open` 的参数里：命中已打开的路径时它会早退，新参数带不进去。
 */
function openPreview(path: string | undefined, name: string, diskPath: string | undefined): void {
  if (!path) return;
  preview.open(path, name);
  if (diskPath) preview.attachDiskPath(path, diskPath);
}
</script>

<template>
  <div v-if="artifacts.length" ref="scrollEl" data-testid="artifacts-panel" class="h-full overflow-y-auto px-3 py-2">
    <!-- 相对容器 + 显式总高：行一律绝对定位在 translateY 处，虚拟与非虚拟共用一套模板 -->
    <ul class="relative" :style="{ height: `${totalHeight}px` }">
      <li
        v-for="slot in slots"
        :key="slot.key"
        :data-index="slot.index"
        data-testid="band-artifact"
        class="absolute left-0 top-0 flex h-[30px] w-full items-center gap-2 rounded-[8px] px-2 transition-colors hover:bg-panel"
        :style="{ transform: `translateY(${slot.start}px)` }"
      >
        <Icon name="folder" :size="13" class="shrink-0 text-dim2" />
        <Hint :text="slot.artifact.path ? `在预览面板打开 ${slot.artifact.path}` : '该产物没有 VFS 路径，无法预览'" multiline>
          <button
            type="button"
            data-testid="band-artifact-name"
            :aria-disabled="!slot.artifact.path || undefined"
            class="min-w-0 flex-1 cursor-pointer truncate text-start text-[12.5px] text-foreground transition-colors hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan aria-disabled:cursor-default aria-disabled:hover:text-foreground"
            @click="openPreview(slot.artifact.path, slot.artifact.name, slot.artifact.diskPath)"
          >
            {{ slot.artifact.name }}
          </button>
        </Hint>
        <span class="shrink-0 text-[10.5px] text-dim2">{{ slot.artifact.meta }}</span>
      </li>
    </ul>
  </div>
  <div v-else data-testid="artifacts-panel-empty" class="flex h-full flex-col items-center justify-center gap-0.5 px-4 text-center">
    <span class="text-[12px] text-dim2">还没有全局产物</span>
    <span class="text-[11px] text-dim2">会话中生成的产物会出现在这里</span>
  </div>
</template>
