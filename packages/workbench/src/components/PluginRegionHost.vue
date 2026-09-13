<script setup lang="ts">
import { computed, ref } from "vue";
import { useDeclarativePluginState } from "../plugins/declarative-state";
import type { MarketUiRegionContribution, CodePluginRuntime, DeclarativeValue, PluginWindowDecl } from "../plugins/market-types";
import { isPluginCapabilityGranted } from "../plugins/runtime";
import PluginRenderLoop from "./PluginRenderLoop.vue";

/**
 * 市场包 uiRegion 贡献的宿主壳：把 worker 渲染循环 + 动作按钮装进既有区域
 * （SiderRegions 分组 / ActivityBand 页签）。
 *
 * - 状态：该区域独立的持久化状态（键 `${pluginId}/region/${regionId}`），
 *   无字段声明 —— 动作 patch 的键即状态键（isPatch 已保证原始值）。
 * - 动作：按钮 → runtime.invoke(handler, state) → patch 全量合并 + 持久化。
 * - 画布：render handler 指令流经渲染循环宿主走白名单。
 * 本组件不含任何插件代码执行路径 —— 渲染/动作都经 worker 沙箱。
 */
const props = defineProps<{
  pluginId: string;
  regionId: string;
  contribution: MarketUiRegionContribution;
  /** 渲染循环声明（Rust 校验保证 worker 包必有）。 */
  render: NonNullable<CodePluginRuntime["render"]>;
  invoke: (handler: string, state: Readonly<Record<string, DeclarativeValue>>) => Promise<Record<string, DeclarativeValue> | void>;
  invokeRaw: (handler: string, state: Readonly<Record<string, DeclarativeValue>>) => Promise<unknown>;
  /** 脱窗声明（window.floating 能力）：非空时显示「弹出桌面」入口。 */
  windowDecl?: PluginWindowDecl;
}>();

const state = useDeclarativePluginState(`${props.pluginId}/region/${props.regionId}`, []);
const busyAction = ref<string | null>(null);
const actionError = ref("");
const pluginWindowBusy = ref(false);
const pluginWindowError = ref("");
/** 脱窗入口可见性：插件声明了 window 且 window.floating 已授权（门禁与能力目录一致）。 */
const canFloat = computed(() => Boolean(props.windowDecl) && isPluginCapabilityGranted("window.floating"));

async function openPluginWindow(): Promise<void> {
  if (pluginWindowBusy.value) return;
  pluginWindowBusy.value = true;
  pluginWindowError.value = "";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("plugin_window_open", { pluginId: props.pluginId });
  } catch (error) {
    pluginWindowError.value = error instanceof Error ? error.message : String(error);
  } finally {
    pluginWindowBusy.value = false;
  }
}

/** 渲染通道：worker render handler（raw 指令流）。 */
const renderChannel = (handler: string, current: Readonly<Record<string, DeclarativeValue>>) => props.invokeRaw(handler, current);

/** 动作：invoke 后把 patch 全量合并进区域状态（primitive 白名单由 isPatch 保证）。 */
async function runAction(actionId: string): Promise<void> {
  if (busyAction.value) return;
  busyAction.value = actionId;
  actionError.value = "";
  try {
    const patch = await props.invoke(actionId, { ...state });
    if (patch) {
      for (const [key, value] of Object.entries(patch)) {
        state[key] = value;
      }
    }
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    busyAction.value = null;
  }
}
</script>

<template>
  <div class="flex flex-col gap-1.5" :data-testid="`region-host-${contribution.id}`">
    <PluginRenderLoop
      :key="contribution.id"
      :render="renderChannel"
      :handler="props.render.handler"
      :state="() => ({ ...state })"
      :width="contribution.width ?? props.render.width ?? 160"
      :height="contribution.height ?? props.render.height ?? 140"
      :fps="props.render.fps ?? 12"
    />
    <div v-if="canFloat" class="flex justify-center">
      <button
        type="button"
        class="h-6 cursor-pointer rounded-[6px] border border-dashed border-line-2 px-2.5 text-[10px] text-dim2 transition-colors hover:border-mint/40 hover:text-mint"
        :disabled="pluginWindowBusy"
        :title="'在桌面弹出透明悬浮窗（' + (props.windowDecl?.width ?? 0) + '×' + (props.windowDecl?.height ?? 0) + '）'"
        :data-testid="`plugin-window-open-${props.pluginId}`"
        @click="openPluginWindow"
      >
        {{ pluginWindowBusy ? "…" : "🪟 弹出桌面" }}
      </button>
    </div>
    <p v-if="pluginWindowError" class="text-center text-[10px] text-orange">{{ pluginWindowError }}</p>
    <div v-if="contribution.actions?.length" class="flex flex-wrap gap-1">
      <button
        v-for="action in contribution.actions"
        :key="action.id"
        type="button"
        class="h-6 cursor-pointer rounded-[6px] border border-line bg-panel-2 px-2 text-[10px] text-dim transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-40"
        :disabled="busyAction === action.id"
        :data-testid="`region-action-${contribution.id}-${action.id}`"
        @click="runAction(action.id)"
      >
        {{ action.label }}
      </button>
    </div>
    <p v-if="actionError" class="text-[10px] text-orange">{{ actionError }}</p>
  </div>
</template>
