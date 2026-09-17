<script setup lang="ts">
/**
 * Mermaid 图块：把 ```mermaid 围栏渲染成图（懒加载，见 lib/mermaid.ts）。
 *
 * - 首帧/重渲前给脉冲骨架占位；渲染成功插入 SVG；
 * - 渲染失败降级为原文代码块 + 一句原因（错误信息与原文都走文本插值，不落 HTML）；
 * - 宿主明暗翻转（订阅 lib/theme 的 APPEARANCE_EVENT）自动重渲；
 * - code 变化（消息内容更新）时重渲并清掉旧图，避免展示过期图。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-vue-next";
import { renderMermaid } from "@/lib/mermaid";
import { isDarkMode, watchTheme } from "@/lib/theme";

const props = defineProps<{ code: string }>();

const host = ref<HTMLElement | null>(null);
const state = ref<"pending" | "ok" | "error">("pending");
const error = ref("");

/** 缩放档位：0.5×–3×，步进 0.25。只改 svg width 像素值，容器随内容自动横向滚动。 */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;
const scale = ref(1);
const percent = computed(() => Math.round(scale.value * 100));

let alive = true;
let renderSeq = 0;
/** 最近一次渲染的 svg 自然宽（px），缩放以它为基准。 */
let naturalPx = 0;
/** 曾经成功渲染过（重渲时保留旧图直到新图就绪，避免骨架闪烁）。 */
let hadContent = false;
let stopWatchTheme: (() => void) | null = null;

/**
 * mermaid 输出的 svg 自带 width:100%（响应式），但宽图会因此被压扁到容器宽，
 * 字号不可读。渲染后把宽度改为 mermaid 计算的自然宽（它写在 svg 内联 max-width 上），
 * 窄图居中、宽图交给宿主横向滚动；缩放在此基础上乘当前 scale。
 */
function applyZoomWidth(): void {
  const el = host.value;
  const svg = el?.firstElementChild;
  if (!(svg instanceof SVGElement) || naturalPx <= 0) return;
  svg.setAttribute("width", `${Math.round(naturalPx * scale.value)}px`);
}

function setSvgWidth(el: HTMLElement): void {
  const svg = el.firstElementChild;
  if (!(svg instanceof SVGElement)) return;
  const natural = parseFloat(svg.style.maxWidth);
  naturalPx = Number.isFinite(natural) && natural > 0 ? natural : 0;
  if (naturalPx > 0) svg.style.maxWidth = "none";
  applyZoomWidth();
}

function zoomBy(delta: number): void {
  const next = Math.round((scale.value + delta) * 100) / 100;
  scale.value = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  applyZoomWidth();
}

function resetZoom(): void {
  scale.value = 1;
  applyZoomWidth();
}

async function draw(): Promise<void> {
  const seq = ++renderSeq;
  const el = host.value;
  if (!hadContent) state.value = "pending";
  error.value = "";
  try {
    const { svg } = await renderMermaid(props.code, isDarkMode());
    if (!alive || seq !== renderSeq) return;
    if (el) {
      el.innerHTML = svg;
      setSvgWidth(el);
    }
    hadContent = true;
    state.value = "ok";
  } catch (cause) {
    if (!alive || seq !== renderSeq) return;
    hadContent = false;
    const message = cause instanceof Error ? cause.message : String(cause);
    error.value = message.length > 320 ? `${message.slice(0, 320)}…` : message;
    state.value = "error";
  }
}

onMounted(() => {
  void draw();
  stopWatchTheme = watchTheme(() => void draw());
});

watch(
  () => props.code,
  () => {
    hadContent = false;
    void draw();
  },
);

onBeforeUnmount(() => {
  alive = false;
  stopWatchTheme?.();
  stopWatchTheme = null;
});
</script>

<template>
  <div class="md-mermaid relative my-[0.7em] overflow-hidden rounded-[8px] border border-line bg-panel-2">
    <!-- 渲染成功：语言标签 + 缩放控制（步进 ±25%，0.5×–3×） -->
    <div v-if="state === 'ok'" class="flex items-center gap-1.5 border-b border-line bg-panel py-1 pl-2.5 pr-1.5">
      <span class="font-mono text-[11px] text-dim2">mermaid</span>
      <span class="min-w-[38px] text-right font-mono text-[10.5px] tabular-nums text-dim2" aria-live="polite">{{ percent }}%</span>
      <span class="ml-auto flex items-center gap-0.5">
        <button
          class="grid size-[20px] cursor-pointer place-items-center rounded-[5px] border border-transparent bg-transparent text-dim2 transition-colors hover:border-line hover:bg-panel-2 hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-dim2"
          type="button"
          aria-label="缩小"
          :disabled="scale <= ZOOM_MIN"
          @click="zoomBy(-ZOOM_STEP)"
        >
          <ZoomOut class="size-3.5" />
        </button>
        <button
          class="grid size-[20px] cursor-pointer place-items-center rounded-[5px] border border-transparent bg-transparent text-dim2 transition-colors hover:border-line hover:bg-panel-2 hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-dim2"
          type="button"
          aria-label="放大"
          :disabled="scale >= ZOOM_MAX"
          @click="zoomBy(ZOOM_STEP)"
        >
          <ZoomIn class="size-3.5" />
        </button>
        <button
          class="grid size-[20px] cursor-pointer place-items-center rounded-[5px] border border-transparent bg-transparent text-dim2 transition-colors hover:border-line hover:bg-panel-2 hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-dim2"
          type="button"
          aria-label="重置缩放"
          :disabled="scale === 1"
          @click="resetZoom"
        >
          <RotateCcw class="size-3.5" />
        </button>
      </span>
    </div>
    <!-- 渲染失败：原文代码块 + 原因（文本插值，注入防线同 MarkdownText） -->
    <div v-if="state === 'error'" class="md-mermaid__fallback">
      <div class="flex items-center gap-2 border-b border-line bg-panel py-1 pl-2.5 pr-2">
        <span class="font-mono text-[11px] text-dim2">mermaid</span>
        <span class="min-w-0 flex-1 truncate text-[11px] text-destructive">{{ error }}</span>
      </div>
      <div class="overflow-x-auto font-mono text-xs leading-[1.6]">
        <pre class="m-0 whitespace-pre px-3 py-2"><code class="[font-family:inherit]">{{ code }}</code></pre>
      </div>
    </div>
    <div
      v-show="state !== 'error'"
      ref="host"
      class="md-mermaid__host overflow-x-auto p-2.5 [&>svg]:mx-auto [&>svg]:block [&>svg]:h-auto"
    ></div>
    <!-- 首帧加载骨架：仅当从未成功时显示，避免遮住旧图 -->
    <div
      v-if="state === 'pending' && !hadContent"
      class="pointer-events-none absolute inset-x-0 top-0 h-6 animate-pulse rounded-b bg-panel"
      aria-hidden="true"
    ></div>
  </div>
</template>
