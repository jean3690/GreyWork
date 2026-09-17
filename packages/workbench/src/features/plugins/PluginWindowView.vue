<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import PluginRenderCanvas from "@/features/plugins/PluginRenderCanvas.vue";
import { createWorkerCodePluginRuntime, type CodePluginRuntime } from "@/plugins/code-runtime";
import { installedMarketPlugins } from "@/plugins/market";
import { validateRenderCommands, type RenderCommand } from "@/plugins/render-commands";

/**
 * 插件悬浮窗视图（隐藏路由 #/plugin-window）：宿主透明置顶窗的内容。
 *
 * - 窗口 label = `plugin-window-<pluginId>`（Rust plugin_window_open 约定），据此反查已装包；
 * - 窗口内自建该包的 worker runtime（沙箱与主窗同构），渲染循环驱动画布；
 * - 无装饰窗口：整块画布按住即拖拽（startDragging），点 × 关闭；
 * - 状态：窗口独立于主窗（同包多实例）；喂食等交互在主窗模式页/侧栏进行。
 */
const PLUGIN_WINDOW_LABEL_PREFIX = "plugin-window-";

const runtime = shallowRef<CodePluginRuntime | null>(null);
const packageInfo = ref<{ id: string; name: string; width: number; height: number; handler: string; fps: number } | null>(null);
const commands = shallowRef<readonly RenderCommand[]>([]);
const errorMessage = ref("");
const dragging = ref(false);

async function startDrag(event: MouseEvent): Promise<void> {
  if (event.button !== 0) return;
  dragging.value = true;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().startDragging();
  } catch {
    // 非 Tauri 预览环境：忽略。
  } finally {
    dragging.value = false;
  }
}

async function closeWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  } catch {
    // ignore
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;

async function pullFrame(): Promise<void> {
  const current = runtime.value;
  const info = packageInfo.value;
  if (!current || !info || inFlight || typeof document === "undefined" || document.hidden) return;
  inFlight = true;
  try {
    const raw = await current.invokeRaw(info.handler, {});
    const validated = validateRenderCommands(raw);
    if (validated) commands.value = validated;
  } catch {
    // 该帧失败跳过。
  } finally {
    inFlight = false;
  }
}

onMounted(async () => {
  try {
    // 窗口 label 反查插件。
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const label = getCurrentWindow().label;
    const pluginId = label.startsWith(PLUGIN_WINDOW_LABEL_PREFIX) ? label.slice(PLUGIN_WINDOW_LABEL_PREFIX.length) : "";
    const pkg = installedMarketPlugins.value.find((item) => item.manifest.id === pluginId);
    const render = pkg?.manifest.runtime?.render;
    if (!pkg?.code || !render || !pkg.manifest.window) {
      errorMessage.value = "未找到可显示的插件（需 worker + render + window 声明）";
      return;
    }
    packageInfo.value = {
      id: pkg.manifest.id,
      name: pkg.manifest.name,
      width: pkg.manifest.window.width,
      height: pkg.manifest.window.height,
      handler: render.handler,
      fps: render.fps ?? 12,
    };
    const hostCall = (_capability: string, _args: unknown): Promise<unknown> =>
      Promise.reject(new Error("window instance has no host capabilities"));
    runtime.value = createWorkerCodePluginRuntime({ schemaVersion: 1, code: pkg.code, manifest: pkg.manifest }, hostCall);
    void pullFrame();
    timer = setInterval(() => void pullFrame(), 1000 / Math.min(Math.max(render.fps ?? 12, 1), 60));
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
});

onBeforeUnmount(() => {
  if (timer !== undefined) clearInterval(timer);
  runtime.value?.dispose();
});
</script>

<template>
  <div
    class="flex h-screen w-screen select-none flex-col items-center justify-center overflow-hidden bg-transparent"
    data-testid="plugin-window"
    @mousedown="startDrag"
  >
    <!-- 顶部：名称 + 关闭 -->
    <div class="pointer-events-none absolute left-0 right-0 top-0 flex items-center justify-between px-2">
      <span class="text-[9px] font-medium uppercase tracking-wide text-dim2/80">{{ packageInfo?.name ?? "" }}</span>
      <button
        type="button"
        class="pointer-events-auto grid size-6 cursor-pointer place-items-center rounded-full text-[10px] text-dim2 hover:bg-panel-2 hover:text-foreground"
        aria-label="关闭"
        data-testid="plugin-window-close"
        @click.stop="closeWindow"
      >
        ×
      </button>
    </div>

    <!-- 画布：指令流渲染（无插件代码直跑，复用受控渲染组件）。 -->
    <PluginRenderCanvas
      v-if="packageInfo"
      :commands="commands"
      :width="packageInfo.width"
      :height="packageInfo.height"
      class="overflow-visible"
      data-testid="plugin-window-canvas"
    />

    <p v-if="errorMessage" class="px-4 text-center text-[11px] text-dim2">{{ errorMessage }}</p>
    <p v-if="packageInfo && !errorMessage" class="absolute bottom-1 left-0 right-0 text-center text-[9px] text-dim2/60">
      拖动挪窝 · 喂食在主窗
    </p>
  </div>
</template>
