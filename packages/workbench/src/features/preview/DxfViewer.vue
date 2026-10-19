<script setup lang="ts">
/**
 * CAD 预览：DXF（ASCII）→ canvas 2D。
 *
 * 只做「看图纸」这一层：折线 / 圆 / 弧 / 多段线 / 文字 / 块引用由 `lib/dxf.ts` 归一化，
 * 这里负责视口变换 —— 滚轮以指针为中心缩放、按住拖拽平移、工具栏按钮缩放 / 适应范围。
 *
 * 用 canvas 而不是 SVG：总平面图上万条线段时，SVG 的节点数会让缩放明显掉帧；
 * canvas 每次重绘一条路径列表，点数上限由解析层兜住（200k）。
 *
 * 视口状态（scale / offset）在换图时重置为「适应范围」；同一文件的内容刷新
 * （revision 变）也重置 —— CAD 文件重新导出后范围通常已经变了，沿用旧视口只会看到空白。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, toRef, watch } from "vue";
import Icon from "@/features/shared/Icon.vue";
import PreviewExternalButton from "@/features/preview/PreviewExternalButton.vue";
import { usePreviewText } from "@/lib/preview-content";
import { parseDxf, type DxfDrawing } from "@/lib/dxf";
import { i18n } from "@/i18n";
import type { PreviewTab } from "@/stores/preview";

const props = defineProps<{ tab: PreviewTab }>();
const t = i18n.global.t;

const { data, loading, error } = usePreviewText(toRef(props, "tab"));

const stage = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
/** 解析失败（与读取失败分开显示）。 */
const parseError = ref<string | null>(null);
/** 解析结果点数组很大，不能交给 Vue 做深层响应式。 */
const drawing = shallowRef<DxfDrawing | null>(null);

/** CSS 像素 / 世界单位。 */
const scale = ref(1);
/** 屏幕偏移：屏幕 x = worldX · scale + offset.x，屏幕 y = -worldY · scale + offset.y。 */
const offset = ref({ x: 0, y: 0 });
const fitScale = ref(1);
const dragging = ref(false);
/** 用户动过视口后，窗口尺寸变化不再自动回到「适应范围」。 */
let userAdjusted = false;

const zoomPercent = computed(() => {
  const ratio = fitScale.value > 0 ? scale.value / fitScale.value : 1;
  return `${Math.round(ratio * 100)}%`;
});

const stats = computed(() => {
  const d = drawing.value;
  if (!d) return null;
  return d.skipped > 0
    ? `${t("preview.dxf.entities", { count: d.entityCount })} · ${t("preview.dxf.skipped", { count: d.skipped })}`
    : t("preview.dxf.entities", { count: d.entityCount });
});

let observer: ResizeObserver | null = null;
let frame = 0;

function clampScale(value: number): number {
  const base = fitScale.value > 0 ? fitScale.value : 1;
  return Math.min(base * 400, Math.max(base * 0.02, value));
}

function scheduleDraw(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    draw();
  });
}

function draw(): void {
  const host = stage.value;
  const element = canvas.value;
  if (!host || !element) return;
  const width = host.clientWidth;
  const height = host.clientHeight;
  if (width === 0 || height === 0) return;

  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (element.width !== pixelWidth) element.width = pixelWidth;
  if (element.height !== pixelHeight) element.height = pixelHeight;

  const context = element.getContext("2d");
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  const d = drawing.value;
  if (!d) return;
  const current = scale.value;
  const { x: offsetX, y: offsetY } = offset.value;
  const screenX = (x: number): number => x * current + offsetX;
  const screenY = (y: number): number => -y * current + offsetY;

  context.lineWidth = 1;
  context.lineJoin = "round";
  context.lineCap = "round";

  for (const path of d.paths) {
    const first = path.points[0];
    if (!first) continue;
    context.beginPath();
    context.moveTo(screenX(first.x), screenY(first.y));
    for (let index = 1; index < path.points.length; index += 1) {
      const point = path.points[index];
      context.lineTo(screenX(point.x), screenY(point.y));
    }
    if (path.closed) context.closePath();
    if (path.fill) {
      context.globalAlpha = 0.18;
      context.fillStyle = path.color;
      context.fill();
      context.globalAlpha = 1;
    }
    context.strokeStyle = path.color;
    context.stroke();
  }

  for (const dot of d.dots) {
    context.fillStyle = dot.color;
    context.fillRect(screenX(dot.x) - 1, screenY(dot.y) - 1, 2, 2);
  }

  context.textBaseline = "alphabetic";
  for (const text of d.texts) {
    const pixelHeight = text.height * current;
    // 字太小就跳过：几万条注释文字在缩略视图里只会糊成一片，还拖慢重绘。
    if (pixelHeight < 3) continue;
    context.save();
    context.translate(screenX(text.x), screenY(text.y));
    context.rotate(-text.rotation);
    context.fillStyle = text.color;
    context.font = `${pixelHeight}px ui-sans-serif, system-ui, sans-serif`;
    context.fillText(text.text, 0, 0);
    context.restore();
  }
}

function fit(): void {
  const host = stage.value;
  const d = drawing.value;
  if (!host || !d) return;
  const width = host.clientWidth;
  const height = host.clientHeight;
  if (width === 0 || height === 0) return;

  const bounds = d.bounds;
  if (!bounds) {
    fitScale.value = 1;
    scale.value = 1;
    offset.value = { x: width / 2, y: height / 2 };
    userAdjusted = false;
    scheduleDraw();
    return;
  }

  const margin = 28;
  const worldWidth = Math.max(bounds.maxX - bounds.minX, 1e-9);
  const worldHeight = Math.max(bounds.maxY - bounds.minY, 1e-9);
  const next = Math.min((width - margin * 2) / worldWidth, (height - margin * 2) / worldHeight);
  fitScale.value = Number.isFinite(next) && next > 0 ? next : 1;
  scale.value = fitScale.value;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  offset.value = { x: width / 2 - centerX * scale.value, y: height / 2 + centerY * scale.value };
  userAdjusted = false;
  scheduleDraw();
}

/** 以屏幕坐标 (px, py) 为不动点缩放到 nextScale。 */
function zoomAt(nextScale: number, px: number, py: number): void {
  if (!drawing.value) return;
  const clamped = clampScale(nextScale);
  const worldX = (px - offset.value.x) / scale.value;
  const worldY = (offset.value.y - py) / scale.value;
  scale.value = clamped;
  offset.value = { x: px - worldX * clamped, y: py + worldY * clamped };
  userAdjusted = true;
  scheduleDraw();
}

function zoomBy(factor: number): void {
  const host = stage.value;
  if (!host) return;
  zoomAt(scale.value * factor, host.clientWidth / 2, host.clientHeight / 2);
}

function onWheel(event: WheelEvent): void {
  if (!drawing.value) return;
  event.preventDefault();
  const host = stage.value;
  if (!host) return;
  const rect = host.getBoundingClientRect();
  // deltaY 每格约 100：0.0015 的指数让一格 ≈ 16% 缩放，触控板也不会过冲。
  const factor = Math.exp(-event.deltaY * 0.0015);
  zoomAt(scale.value * factor, event.clientX - rect.left, event.clientY - rect.top);
}

let dragStart: { pointerId: number; x: number; y: number; offsetX: number; offsetY: number } | null = null;

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !drawing.value) return;
  event.preventDefault();
  dragStart = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    offsetX: offset.value.x,
    offsetY: offset.value.y,
  };
  dragging.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  if (!dragStart || dragStart.pointerId !== event.pointerId) return;
  offset.value = {
    x: dragStart.offsetX + (event.clientX - dragStart.x),
    y: dragStart.offsetY + (event.clientY - dragStart.y),
  };
  userAdjusted = true;
  scheduleDraw();
}

function onPointerUp(event: PointerEvent): void {
  if (!dragStart || dragStart.pointerId !== event.pointerId) return;
  dragStart = null;
  dragging.value = false;
  const target = event.currentTarget as HTMLElement;
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
}

watch(
  data,
  (text) => {
    parseError.value = null;
    if (!text) {
      drawing.value = null;
      scheduleDraw();
      return;
    }
    try {
      drawing.value = parseDxf(text);
    } catch (cause) {
      drawing.value = null;
      parseError.value = cause instanceof Error ? cause.message : String(cause);
      return;
    }
    // 等布局稳定后再算适应范围（首帧 stage 可能还没有尺寸）。
    requestAnimationFrame(fit);
  },
  { immediate: true },
);

onMounted(() => {
  const host = stage.value;
  if (host) {
    observer = new ResizeObserver(() => {
      if (!userAdjusted) fit();
      else scheduleDraw();
    });
    observer.observe(host);
    // 元素级 wheel 默认不是 passive，但显式声明才能保证 preventDefault 生效。
    host.addEventListener("wheel", onWheel, { passive: false });
  }
  if (drawing.value) requestAnimationFrame(fit);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  stage.value?.removeEventListener("wheel", onWheel);
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
});

const toolButtonClass =
  "grid size-6 shrink-0 cursor-pointer place-items-center rounded-[calc(6px*var(--gw-radius-scale))] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan";
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span class="min-w-0 flex-1 truncate">{{ props.tab.name }}</span>
      <span v-if="stats" class="shrink-0 tabular-nums" data-testid="dxf-stats">{{ stats }}</span>
      <span v-if="drawing?.truncated" class="shrink-0 text-orange" data-testid="dxf-truncated">
        {{ t("preview.dxf.truncated") }}
      </span>
      <button
        type="button"
        data-testid="dxf-zoom-out"
        :class="toolButtonClass"
        :aria-label="t('preview.dxf.zoomOut')"
        @click="zoomBy(1 / 1.25)"
      >
        <Icon name="minus" :size="12" />
      </button>
      <span class="w-10 shrink-0 text-center tabular-nums" data-testid="dxf-zoom-level">{{ zoomPercent }}</span>
      <button type="button" data-testid="dxf-zoom-in" :class="toolButtonClass" :aria-label="t('preview.dxf.zoomIn')" @click="zoomBy(1.25)">
        <Icon name="plus" :size="12" />
      </button>
      <button type="button" data-testid="dxf-fit" :class="toolButtonClass" :aria-label="t('preview.dxf.fit')" @click="fit()">
        {{ t("preview.dxf.fit") }}
      </button>
    </div>

    <div v-if="error" role="alert" class="flex flex-wrap items-center gap-2 px-4 py-3">
      <span class="text-[12px] text-orange">{{ t("preview.common.readFailed", { detail: error }) }}</span>
      <PreviewExternalButton :tab="tab" />
    </div>
    <div v-else class="relative min-h-0 flex-1">
      <div
        ref="stage"
        data-testid="dxf-stage"
        class="absolute inset-0 touch-none overflow-hidden bg-background"
        :class="dragging ? 'cursor-grabbing' : 'cursor-grab'"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      >
        <canvas ref="canvas" data-testid="dxf-canvas" class="block size-full" />
      </div>
      <p v-if="loading" class="pointer-events-none absolute inset-0 grid place-items-center bg-panel/80 px-4 text-[12px] text-dim2">
        {{ t("preview.common.loading") }}
      </p>
      <div
        v-if="parseError"
        role="alert"
        class="absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-2 border-t border-line bg-panel/95 px-4 py-2"
      >
        <span class="min-w-0 flex-1 text-[11.5px] text-orange">{{ t("preview.dxf.parseFailed", { detail: parseError }) }}</span>
        <PreviewExternalButton :tab="tab" />
      </div>
    </div>
  </div>
</template>
