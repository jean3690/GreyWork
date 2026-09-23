<script setup lang="ts">
/**
 * 图片预览：适应窗口 / 缩放（按钮 + 滚轮）/ 平移 / 旋转 90°。
 *
 * `URL.createObjectURL` 产生的 URL 会一直持有底层 Blob，直到显式 revoke。
 * 切几十次 tab 就是几十份图片留在内存里，所以**换内容与卸载时都必须 revoke** ——
 * 这是本组件唯一容易漏的地方。
 *
 * **视图变换全走 CSS transform，不改布局**：`<img>` 的 `max-w/max-h + object-contain`
 * 负责「适应窗口」这一档（scale=1 就是它），放大缩小 / 旋转 / 平移都只是在它上面叠
 * transform。好处是 `<img>` 的 `src` / `alt` / 布局盒都不动 —— 测试与划词都还认它。
 * 代价是放大后位图会糊（没有重采样）；对预览来说可以接受。
 */
import { computed, onMounted, onUnmounted, ref, toRef, watch } from "vue";
import { extname } from "@greywork/core";
import Icon from "@/features/shared/Icon.vue";
import { usePreviewBinary } from "@/lib/preview-content";
import PreviewExternalButton from "@/features/preview/PreviewExternalButton.vue";
import { i18n } from "@/i18n";
import type { PreviewTab } from "@/stores/preview";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
};

/** 缩放上下限：放到 8 倍以上只是糊，缩到 0.1 倍以下点不到按钮。 */
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
/** 按钮/滚轮每一档的倍率。 */
const ZOOM_STEP = 1.25;

const props = defineProps<{ tab: PreviewTab }>();

/** 直挂组件（测试）时可能没有 i18n 插件，故用全局实例而非 useI18n。 */
const t = i18n.global.t;

const { data, loading, error } = usePreviewBinary(toRef(props, "tab"));

const objectUrl = ref<string | null>(null);

/** 视图变换：缩放倍率、旋转角度（0/90/180/270）、平移（transform 顺序里在最外层）。 */
const scale = ref(1);
const rotation = ref(0);
const offset = ref({ x: 0, y: 0 });
const dragging = ref(false);

const stage = ref<HTMLElement | null>(null);
const image = ref<HTMLImageElement | null>(null);

/** 图片的原始像素尺寸：1:1 档要靠它算倍数。load 事件里填。 */
const natural = ref({ width: 0, height: 0 });

const transformStyle = computed(() => ({
  transform: `translate(${offset.value.x}px, ${offset.value.y}px) scale(${scale.value}) rotate(${rotation.value}deg)`,
}));

/**
 * 「适应窗口」在当前旋转角下的倍率。
 *
 * 未旋转时就是 1（`object-contain` 本身就是适应）；旋转 90°/270° 时视觉宽高互换，
 * 竖图横放会溢出容器，所以按互换后的尺寸再收一次。
 * 拿不到布局（happy-dom 无布局，offsetWidth 恒 0）时退回 1，不做无谓的猜测。
 */
const fittedScale = computed(() => fitScaleAfterRotation(rotation.value));

/** 是否处于「非适应」状态：决定抓手光标与「适应」按钮的选中态。 */
const zoomed = computed(() => offset.value.x !== 0 || offset.value.y !== 0 || Math.abs(scale.value - fittedScale.value) > 0.001);

function clamp(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function fitScaleAfterRotation(degrees: number): number {
  const box = image.value;
  const host = stage.value;
  if (!box || !host) return 1;
  const swapped = degrees % 180 !== 0;
  const visualWidth = swapped ? box.offsetHeight : box.offsetWidth;
  const visualHeight = swapped ? box.offsetWidth : box.offsetHeight;
  if (!visualWidth || !visualHeight || !host.clientWidth || !host.clientHeight) return 1;
  return clamp(Math.min(1, host.clientWidth / visualWidth, host.clientHeight / visualHeight));
}

function resetView(): void {
  scale.value = 1;
  rotation.value = 0;
  offset.value = { x: 0, y: 0 };
}

function zoomTo(next: number): void {
  scale.value = clamp(next);
  if (Math.abs(scale.value - fittedScale.value) <= 0.001) offset.value = { x: 0, y: 0 };
}

/** 适应窗口：按**当前旋转角**算，转过的图也一定装得下。 */
function fit(): void {
  scale.value = fittedScale.value;
  offset.value = { x: 0, y: 0 };
}

/** 1:1：按原始像素显示。布局盒是 contain 后的尺寸，倍数就是「原始宽 / 盒宽」。 */
function actualSize(): void {
  const box = image.value;
  if (!box || !box.offsetWidth || !natural.value.width) {
    fit();
    return;
  }
  scale.value = clamp(natural.value.width / box.offsetWidth);
  offset.value = { x: 0, y: 0 };
}

function rotate(direction: 1 | -1): void {
  rotation.value = (rotation.value + direction * 90 + 360) % 360;
  offset.value = { x: 0, y: 0 };
  scale.value = fitScaleAfterRotation(rotation.value);
}

/** 滚轮缩放：以指针为不动点。`passive: false` 才能 preventDefault 拦掉容器滚动。 */
function onWheel(event: WheelEvent): void {
  const host = stage.value;
  const box = image.value;
  if (!host || !box) return;
  event.preventDefault();
  const previous = scale.value;
  const next = clamp(previous * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
  if (next === previous) return;
  const rect = host.getBoundingClientRect();
  // 指针相对容器中心的位置；transform-origin 是元素中心，所以不动点按中心算。
  const dx = event.clientX - (rect.left + rect.width / 2);
  const dy = event.clientY - (rect.top + rect.height / 2);
  const ratio = next / previous;
  offset.value = {
    x: dx - ratio * (dx - offset.value.x),
    y: dy - ratio * (dy - offset.value.y),
  };
  scale.value = next;
}

let dragStart: { x: number; y: number; offsetX: number; offsetY: number } | null = null;

function onPointerDown(event: PointerEvent): void {
  if (!image.value) return;
  dragging.value = true;
  dragStart = { x: event.clientX, y: event.clientY, offsetX: offset.value.x, offsetY: offset.value.y };
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value || !dragStart) return;
  offset.value = { x: dragStart.offsetX + (event.clientX - dragStart.x), y: dragStart.offsetY + (event.clientY - dragStart.y) };
}

function onPointerUp(): void {
  dragging.value = false;
  dragStart = null;
}

function release(): void {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
  objectUrl.value = null;
}

/** 记下原始像素尺寸：1:1 档与旋转后的重新适配都要靠它。 */
function onImageLoad(event: Event): void {
  const target = event.target as HTMLImageElement | null;
  if (!target) return;
  natural.value = { width: target.naturalWidth, height: target.naturalHeight };
}

watch(
  data,
  (bytes) => {
    release();
    // 内容换了就把视图也归位：沿用上一张图的缩放/旋转会让人以为新图是坏的。
    resetView();
    if (!bytes) return;
    const ext = extname(props.tab.path).toLowerCase();
    // 未知扩展给 octet-stream：浏览器仍会尝试嗅探，但不会因为错误 MIME 拒绝渲染。
    const blob = new Blob([bytes as BlobPart], { type: MIME[ext] ?? "application/octet-stream" });
    objectUrl.value = URL.createObjectURL(blob);
  },
  { immediate: true },
);

onMounted(() => stage.value?.addEventListener("wheel", onWheel, { passive: false }));
onUnmounted(() => {
  stage.value?.removeEventListener("wheel", onWheel);
  release();
});

const toolButtonClass =
  "grid size-6 shrink-0 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan";
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span class="min-w-0 flex-1 truncate">{{ props.tab.name }}</span>
      <button
        type="button"
        data-testid="image-zoom-out"
        :class="toolButtonClass"
        :aria-label="t('preview.image.zoomOut')"
        @click="zoomTo(scale / ZOOM_STEP)"
      >
        <Icon name="minus" :size="12" />
      </button>
      <span class="w-10 shrink-0 text-center tabular-nums" data-testid="image-zoom-level">{{ Math.round(scale * 100) }}%</span>
      <button
        type="button"
        data-testid="image-zoom-in"
        :class="toolButtonClass"
        :aria-label="t('preview.image.zoomIn')"
        @click="zoomTo(scale * ZOOM_STEP)"
      >
        <Icon name="plus" :size="12" />
      </button>
      <button
        type="button"
        data-testid="image-fit"
        :class="toolButtonClass"
        :aria-label="t('preview.image.fit')"
        :aria-pressed="!zoomed"
        @click="fit()"
      >
        {{ t("preview.image.fit") }}
      </button>
      <button
        type="button"
        data-testid="image-actual"
        :class="toolButtonClass"
        :aria-label="t('preview.image.actual')"
        @click="actualSize()"
      >
        1:1
      </button>
      <button
        type="button"
        data-testid="image-rotate-left"
        :class="toolButtonClass"
        :aria-label="t('preview.image.rotateLeft')"
        @click="rotate(-1)"
      >
        <Icon name="rotate-left" :size="12" />
      </button>
      <button
        type="button"
        data-testid="image-rotate-right"
        :class="toolButtonClass"
        :aria-label="t('preview.image.rotateRight')"
        @click="rotate(1)"
      >
        <Icon name="rotate-right" :size="12" />
      </button>
    </div>

    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">{{ t("preview.common.loading") }}</p>
    <div v-else-if="error" role="alert" class="flex flex-wrap items-center gap-2 px-4 py-3">
      <span class="text-[12px] text-orange">{{ t("preview.common.readFailed", { detail: error }) }}</span>
      <PreviewExternalButton :tab="tab" />
    </div>
    <div
      v-else-if="objectUrl"
      ref="stage"
      data-testid="image-stage"
      class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-background p-3"
      :class="zoomed ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : ''"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <img
        ref="image"
        data-testid="image-viewer"
        :src="objectUrl"
        :alt="props.tab.name"
        class="max-h-full max-w-full select-none object-contain"
        :style="transformStyle"
        draggable="false"
        @load="onImageLoad"
      />
    </div>
  </div>
</template>
