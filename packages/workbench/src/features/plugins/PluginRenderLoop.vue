<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import PluginRenderCanvas from "@/features/plugins/PluginRenderCanvas.vue";
import { validateRenderCommands, type RenderCommand } from "@/plugins/render-commands";
import { isPatch, type PluginPointerEvent, type PluginPointerType } from "@/plugins/code-runtime";
import type { DeclarativeValue } from "@/plugins/market-types";

/**
 * 插件渲染循环宿主：按声明的 fps 轮询 worker 的 render handler，
 * 拉取绘图指令 → 白名单校验 → 交给 PluginRenderCanvas 画。
 *
 * - worker 侧无定时器、无 DOM：帧节奏由宿主 setInterval 驱动；
 * - 校验失败的帧静默丢弃（保留上一帧），连续失败不中断循环（渲染问题不该杀插件）；
 * - 组件卸载即停循环；页面不可见（document.hidden）时暂停轮询省电。
 * - 指针回传（render.pointer）：宿主把画布指针事件归一化后交给 worker 的
 *   registerPointer 处理器，返回的补丁经 isPatch 校验后由宿主合并；事件与补丁都在
 *   宿主侧构造/校验，worker 侧仍零 DOM。
 */
const props = defineProps<{
  /** worker 渲染 handler 调用通道（与 invoke 同一条消息链）。 */
  render: (handler: string, state: Readonly<Record<string, DeclarativeValue>>) => Promise<unknown>;
  handler: string;
  /** 当前插件状态（每帧快照传给 worker，驱动派生动画）。 */
  state: () => Readonly<Record<string, DeclarativeValue>>;
  fps?: number;
  width?: number;
  height?: number;
  /** 指针回传开关（来自 render.pointer 声明）；开启才监听画布指针事件。 */
  pointer?: boolean;
  /** 指针事件通道：把归一化事件交给 worker（返回状态补丁）。 */
  pointerChannel?: (event: PluginPointerEvent, state: Readonly<Record<string, DeclarativeValue>>) => Promise<unknown>;
  /** worker 指针处理器返回的合法补丁（宿主合并进状态）。 */
  onPointerPatch?: (patch: Record<string, DeclarativeValue>) => void;
}>();

const commands = shallowRef<readonly RenderCommand[]>([]);
const canvasWidth = props.width ?? 240;
const canvasHeight = props.height ?? 180;
// 默认 12fps：宠物级动画足够，省 CPU；上限由 Rust 校验（≤60）。
const intervalMs = 1000 / Math.min(Math.max(props.fps ?? 12, 1), 60);
// 指针队列上限：离散事件保序补发，突发时丢最旧的（交互事件不值得无限积压）。
const MAX_PENDING_POINTERS = 32;

const canvasRef = ref<{ $el?: Element } | Element | null>(null);

let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;

async function pullFrame(): Promise<void> {
  if (inFlight || document.hidden) return;
  inFlight = true;
  try {
    const raw = await props.render(props.handler, props.state());
    // 渲染 handler 返回指令集（非 patch）：走独立校验，非法整帧丢弃。
    const validated = validateRenderCommands(raw);
    if (validated) commands.value = validated;
  } catch {
    // worker 忙/超时：跳过该帧。
  } finally {
    inFlight = false;
  }
}

onMounted(() => {
  void pullFrame();
  timer = setInterval(() => void pullFrame(), intervalMs);
});

onBeforeUnmount(() => {
  if (timer !== undefined) clearInterval(timer);
});

// --- 指针回传 -------------------------------------------------------------

/** 取画布根节点（svg）：坐标以画布为参照，忽略外层留白。 */
function canvasElement(): Element | null {
  const value = canvasRef.value as { $el?: Element } | Element | null;
  if (value && typeof value === "object" && "$el" in value) return (value as { $el?: Element }).$el ?? null;
  return (value as Element | null) ?? null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizePointer(type: PluginPointerType, event: PointerEvent): PluginPointerEvent {
  const rect = canvasElement()?.getBoundingClientRect();
  const left = rect?.left ?? 0;
  const top = rect?.top ?? 0;
  const x = clamp(event.clientX - left, 0, canvasWidth);
  const y = clamp(event.clientY - top, 0, canvasHeight);
  return {
    type,
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2)),
    nx: canvasWidth > 0 ? Number((x / canvasWidth).toFixed(4)) : 0,
    ny: canvasHeight > 0 ? Number((y / canvasHeight).toFixed(4)) : 0,
    buttons: event.buttons ?? 0,
    pointerId: event.pointerId ?? 0,
  };
}

const discretePointers: PluginPointerEvent[] = [];
let pendingMove: PluginPointerEvent | null = null;
let drainingPointers = false;

/** 串行派发：一次只有一个在途，move 合并、离散事件保序，避免高频事件淹没 worker。 */
async function drainPointers(): Promise<void> {
  if (drainingPointers) return;
  drainingPointers = true;
  try {
    for (;;) {
      let pointer: PluginPointerEvent;
      if (discretePointers.length > 0) {
        pointer = discretePointers.shift()!;
      } else if (pendingMove) {
        pointer = pendingMove;
        pendingMove = null;
      } else {
        break;
      }
      try {
        const patch = await props.pointerChannel?.(pointer, props.state());
        if (patch && isPatch(patch)) props.onPointerPatch?.(patch);
      } catch {
        // worker 忙/超时：丢弃该事件（不中断交互）。
      }
    }
  } finally {
    drainingPointers = false;
  }
}

function enqueuePointer(type: PluginPointerType, event: PointerEvent): void {
  if (!props.pointer || !props.pointerChannel) return;
  const pointer = normalizePointer(type, event);
  if (type === "move") {
    pendingMove = pointer;
  } else {
    if (discretePointers.length >= MAX_PENDING_POINTERS) discretePointers.shift();
    discretePointers.push(pointer);
  }
  void drainPointers();
}
</script>

<template>
  <div
    class="relative mx-auto"
    data-testid="plugin-render-loop"
    :style="props.pointer ? { touchAction: 'none' } : undefined"
    @pointerdown="enqueuePointer('down', $event)"
    @pointermove="enqueuePointer('move', $event)"
    @pointerup="enqueuePointer('up', $event)"
    @pointercancel="enqueuePointer('cancel', $event)"
    @pointerleave="enqueuePointer('leave', $event)"
  >
    <div
      class="rounded-[calc(14px*var(--gw-radius-scale))] border border-line bg-panel-2 p-2"
      :class="props.pointer ? 'cursor-crosshair' : ''"
    >
      <PluginRenderCanvas ref="canvasRef" :commands="commands" :width="canvasWidth" :height="canvasHeight" />
    </div>
  </div>
</template>
