<script setup lang="ts">
import { computed, ref } from "vue";
import Icon from "../components/Icon.vue";
import { useCapabilityLoader } from "../plugins/current";
import { isPluginEnabled, pluginActive, pluginManifests, setPluginEnabled } from "../plugins/runtime";

/**
 * 插件中心（本身是内置插件 core.plugins 贡献的一个模式页）。
 *
 * 展示已注册清单与启停状态；开关即 loader.activate/deactivate —— 停用当前页
 * 的插件会让本页随之消失（/plugin/plugins 回退到「不存在或已停用」），
 * 这是插件系统真实生效的最直观演示。第三方插件经 registerPlugin 追加。
 */
const loader = useCapabilityLoader();

/** seam 当前快照（响应式）：模式页贡献实时反映启停结果。 */
const contributedModes = computed(() => loader.snapshot().modes.map((mode) => ({ id: mode.id, title: mode.title })));

const busyId = ref<string | null>(null);
const notice = ref<{ kind: "ok" | "error"; text: string } | null>(null);

async function toggle(manifestId: string, enabled: boolean): Promise<void> {
  busyId.value = manifestId;
  notice.value = null;
  try {
    await setPluginEnabled(manifestId, enabled);
    notice.value = { kind: "ok", text: enabled ? `已启用 ${manifestId}` : `已停用 ${manifestId}` };
  } catch (error) {
    notice.value = { kind: "error", text: error instanceof Error ? error.message : String(error) };
  } finally {
    busyId.value = null;
  }
}
</script>

<template>
  <div class="mx-auto flex h-full min-h-0 w-full max-w-[760px] flex-col gap-3 overflow-y-auto p-5">
    <header class="flex items-center gap-2">
      <span class="grid size-7 place-items-center rounded-[8px] bg-panel text-dim">
        <Icon name="magic" :size="15" />
      </span>
      <div class="min-w-0 flex-1">
        <h1 class="text-[15px] font-semibold text-foreground">插件中心</h1>
        <p class="text-[11.5px] text-dim2">已注册 {{ pluginManifests.length }} · 活跃 {{ pluginActive.length }}</p>
      </div>
    </header>

    <p
      v-if="notice"
      role="status"
      class="rounded-[8px] border px-2.5 py-1.5 text-[12px]"
      :class="notice.kind === 'error' ? 'border-red-400/40 bg-red-400/10 text-red-400' : 'border-line bg-panel-2 text-dim'"
    >
      {{ notice.text }}
    </p>

    <section v-if="contributedModes.length" class="flex flex-wrap items-center gap-1.5">
      <span class="text-[11px] text-dim2">已贡献模式页：</span>
      <span
        v-for="mode in contributedModes"
        :key="mode.id"
        class="rounded-[6px] border border-line-2 bg-panel px-1.5 py-0.5 text-[11px] text-foreground"
        :data-testid="`mode-chip-${mode.id}`"
      >
        {{ mode.title }}
      </span>
    </section>

    <ul class="flex flex-col gap-2">
      <li
        v-for="manifest in pluginManifests"
        :key="manifest.id"
        class="flex items-start gap-3 rounded-[10px] border border-line-2 bg-panel-2 px-3 py-2.5"
        :data-testid="`plugin-card-${manifest.id}`"
      >
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="truncate text-[13px] font-medium text-foreground">{{ manifest.name }}</span>
            <code class="shrink-0 text-[10.5px] text-dim2">{{ manifest.id }}</code>
            <code class="shrink-0 text-[10.5px] text-dim2">v{{ manifest.version }}</code>
          </div>
          <p v-if="manifest.description" class="mt-0.5 text-[12px] text-dim">{{ manifest.description }}</p>
          <p v-if="manifest.dependsOn?.length" class="mt-1 text-[10.5px] text-dim2">依赖：{{ manifest.dependsOn.join(", ") }}</p>
        </div>
        <button
          type="button"
          class="grid h-7 w-14 shrink-0 cursor-pointer place-items-center rounded-[7px] text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          :class="isPluginEnabled(manifest.id) ? 'border border-line bg-panel text-dim' : 'bg-cyan text-white'"
          :disabled="busyId === manifest.id"
          :aria-pressed="isPluginEnabled(manifest.id)"
          :data-testid="`plugin-toggle-${manifest.id}`"
          @click="toggle(manifest.id, !isPluginEnabled(manifest.id))"
        >
          {{ busyId === manifest.id ? "…" : isPluginEnabled(manifest.id) ? "停用" : "启用" }}
        </button>
      </li>
    </ul>

    <p class="text-[11px] text-dim2">第三方插件由宿主代码调用 registerPlugin() 注册，本页即可启停。</p>
  </div>
</template>
