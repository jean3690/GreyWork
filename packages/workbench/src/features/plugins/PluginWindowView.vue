<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import PluginRenderCanvas from "@/features/plugins/PluginRenderCanvas.vue";
import { createWorkerCodePluginRuntime, type CodePluginRuntime } from "@/plugins/code-runtime";
import { installedMarketPlugins } from "@/plugins/market";
import { validateRenderCommands, type RenderCommand } from "@/plugins/render-commands";
import Icon from "@/features/shared/Icon.vue";
import { hostWindow } from "@greywork/host-ipc";

/**
 * 插件悬浮窗视图（隐藏路由 #/plugin-window）：宿主透明置顶窗的内容。
 *
 * - 窗口 label = `plugin-window-<pluginId>[::<n>]`（宿主 plugin-window.ts 约定），据此反查已装包；
 *   `::` 后面是多开实例号，反查只取前段；
 * - 窗口内自建该包的 worker runtime（沙箱与主窗同构），渲染循环驱动画布；
 * - 无装饰窗口：整块画布按住即拖拽（startDragging），点 × 关闭；
 * - 状态：窗口独立于主窗（同包多实例）；喂食等交互在主窗模式页/侧栏进行。
 */
const PLUGIN_WINDOW_LABEL_PREFIX = "plugin-window-";

const runtime = shallowRef<CodePluginRuntime | null>(null);
const packageInfo = ref<{ id: string; name: string; title: string; width: number; height: number; handler: string; fps: number } | null>(
  null,
);
/** 置顶状态：初值来自 manifest（缺省 true），按钮点了以宿主返回的实际状态为准。 */
const pinned = ref(true);
const commands = shallowRef<readonly RenderCommand[]>([]);
const errorMessage = ref("");
const dragging = ref(false);

async function startDrag(event: MouseEvent): Promise<void> {
  if (event.button !== 0) return;
  dragging.value = true;
  try {
    await hostWindow()?.startDragging();
  } catch {
    // 非 Tauri 预览环境：忽略。
  } finally {
    dragging.value = false;
  }
}

/** 「钉住」：走宿主的 setAlwaysOnTop（作用于本窗口，多开时不会切错）。 */
async function togglePin(): Promise<void> {
  const host = hostWindow();
  if (!host) return;
  try {
    pinned.value = await host.setAlwaysOnTop(!pinned.value);
  } catch {
    // 宿主拒绝（例如主窗不支持置顶）：保持原状态，不弹错。
  }
}

async function closeWindow(): Promise<void> {
  try {
    await hostWindow()?.close();
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
    const label = hostWindow()?.label ?? "";
    // 多开时 label 形如 `plugin-window-<id>::2`：反查只取 `::` 之前的部分。
    const pluginId = label.startsWith(PLUGIN_WINDOW_LABEL_PREFIX) ? label.slice(PLUGIN_WINDOW_LABEL_PREFIX.length).split("::")[0] : "";
    const pkg = installedMarketPlugins.value.find((item) => item.manifest.id === pluginId);
    const render = pkg?.manifest.runtime?.render;
    if (!pkg?.code || !render || !pkg.manifest.window) {
      errorMessage.value = "未找到可显示的插件（需 worker + render + window 声明）";
      return;
    }
    pinned.value = pkg.manifest.window.alwaysOnTop !== false;
    packageInfo.value = {
      id: pkg.manifest.id,
      name: pkg.manifest.name,
      title: pkg.manifest.window.title?.trim() || pkg.manifest.name,
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
    <!-- 顶部：标题 + 置顶 + 关闭 -->
    <div class="pointer-events-none absolute left-0 right-0 top-0 flex items-center justify-between px-2">
      <span class="truncate text-[9px] font-medium uppercase tracking-wide text-dim2/80">{{ packageInfo?.title ?? "" }}</span>
      <span class="flex items-center gap-0.5">
        <button
          type="button"
          class="pointer-events-auto grid size-6 cursor-pointer place-items-center rounded-full text-[10px] transition-colors hover:bg-panel-2 hover:text-foreground"
          :class="pinned ? 'text-foreground' : 'text-dim2'"
          :aria-pressed="pinned"
          :title="pinned ? '取消置顶' : '置顶'"
          data-testid="plugin-window-pin"
          @click.stop="togglePin"
        >
          <Icon name="pin" :size="11" />
        </button>
        <button
          type="button"
          class="pointer-events-auto grid size-6 cursor-pointer place-items-center rounded-full text-[11px] text-dim2 hover:bg-panel-2 hover:text-foreground"
          aria-label="关闭"
          data-testid="plugin-window-close"
          @click.stop="closeWindow"
        >
          ×
        </button>
      </span>
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
