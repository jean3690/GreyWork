<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import PluginRenderCanvas from "@/features/plugins/PluginRenderCanvas.vue";
import { validateRenderCommands, type RenderCommand } from "@/plugins/render-commands";
import type { DeclarativeValue } from "@/plugins/market-types";

/**
 * 插件渲染循环宿主：按声明的 fps 轮询 worker 的 render handler，
 * 拉取绘图指令 → 白名单校验 → 交给 PluginRenderCanvas 画。
 *
 * - worker 侧无定时器、无 DOM：帧节奏由宿主 setInterval 驱动；
 * - 校验失败的帧静默丢弃（保留上一帧），连续失败不中断循环（渲染问题不该杀插件）；
 * - 组件卸载即停循环；页面不可见（document.hidden）时暂停轮询省电。
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
}>();

const commands = shallowRef<readonly RenderCommand[]>([]);
const canvasWidth = props.width ?? 240;
const canvasHeight = props.height ?? 180;
// 默认 12fps：宠物级动画足够，省 CPU；上限由 Rust 校验（≤60）。
const intervalMs = 1000 / Math.min(Math.max(props.fps ?? 12, 1), 60);

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

const error = ref("");
</script>

<template>
  <div class="relative mx-auto" data-testid="plugin-render-loop">
    <div class="rounded-[14px] border border-line bg-panel-2 p-2">
      <PluginRenderCanvas :commands="commands" :width="canvasWidth" :height="canvasHeight" />
    </div>
    <p v-if="error" class="mt-1 text-center text-[10px] text-dim2">{{ error }}</p>
  </div>
</template>
