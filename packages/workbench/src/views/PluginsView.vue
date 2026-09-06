<script setup lang="ts">
import { computed, ref } from "vue";
import { i18n } from "../i18n";
import Icon from "../components/Icon.vue";
import { useCapabilityLoader } from "../plugins/current";
import { isPluginEnabled, pluginActive, pluginManifests, restoreBuiltinPlugins, setPluginEnabled } from "../plugins/runtime";

/**
 * 插件中心（本身是内置插件 core.plugins 贡献的一个模式页）。
 *
 * 展示已注册清单与启停状态；开关即 loader.activate/deactivate。
 * 停用 core.plugins（本页的宿主插件）会让本页消失 —— 走两步确认，
 * 文案讲明后果与恢复路径（回退页有「恢复内置插件」按钮）。
 */
const t = i18n.global.t;
const loader = useCapabilityLoader();

/** seam 当前快照（响应式）：模式页贡献实时反映启停结果。 */
const contributedModes = computed(() => loader.snapshot().modes.map((mode) => ({ id: mode.id, title: mode.title })));

const busyId = ref<string | null>(null);
/** 停用 core.plugins（自身）前的两步确认。 */
const confirmDisableId = ref<string | null>(null);
const notice = ref<{ kind: "ok" | "error"; text: string } | null>(null);

function requestToggle(manifestId: string, enabled: boolean): void {
  if (!enabled && manifestId === "core.plugins") {
    confirmDisableId.value = manifestId;
    return;
  }
  void toggle(manifestId, enabled);
}

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

function confirmSelfDisable(): void {
  if (confirmDisableId.value === null) return;
  const id = confirmDisableId.value;
  confirmDisableId.value = null;
  void toggle(id, false);
}
</script>

<template>
  <div class="mx-auto flex h-full min-h-0 w-full max-w-[760px] flex-col gap-3 overflow-y-auto p-5">
    <header class="flex items-center gap-2">
      <span class="grid size-7 place-items-center rounded-[8px] bg-panel text-dim">
        <Icon name="magic" :size="15" />
      </span>
      <div class="min-w-0 flex-1">
        <h1 class="text-[15px] font-semibold text-foreground">{{ t("market.centerTitle") }}</h1>
        <p class="text-[11.5px] text-dim2">已注册 {{ pluginManifests.length }} · 活跃 {{ pluginActive.length }}</p>
      </div>
    </header>

    <p
      v-if="notice"
      role="status"
      class="rounded-[8px] border px-2.5 py-1.5 text-[12px]"
      :class="notice.kind === 'error' ? 'border-orange/40 bg-orange/10 text-orange' : 'border-line bg-panel-2 text-dim'"
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

    <ul v-if="pluginManifests.length" class="flex flex-col gap-2">
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

        <!-- 停用插件中心自身：两步确认 + 恢复路径说明 -->
        <div v-if="confirmDisableId === manifest.id" class="flex shrink-0 flex-col items-end gap-1.5">
          <span class="max-w-[300px] rounded-[8px] bg-amber/15 px-2 py-1 text-right text-[10.5px] leading-snug text-amber">
            {{ t("market.selfDisableWarn") }}
          </span>
          <div class="flex gap-1.5">
            <button
              type="button"
              class="h-7 cursor-pointer rounded-[7px] bg-orange px-2.5 text-[12px] text-white transition-opacity hover:opacity-90"
              @click="confirmSelfDisable"
            >
              {{ t("common.delete") }}
            </button>
            <button
              type="button"
              class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel px-2.5 text-[12px] text-dim transition-colors hover:border-line-2"
              @click="confirmDisableId = null"
            >
              {{ t("common.cancel") }}
            </button>
          </div>
        </div>
        <button
          v-else
          type="button"
          class="grid h-7 w-14 shrink-0 cursor-pointer place-items-center rounded-[7px] text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          :class="isPluginEnabled(manifest.id) ? 'border border-line bg-panel text-dim' : 'bg-accent text-accent-ink'"
          :disabled="busyId === manifest.id"
          :aria-pressed="isPluginEnabled(manifest.id)"
          :data-testid="`plugin-toggle-${manifest.id}`"
          @click="requestToggle(manifest.id, !isPluginEnabled(manifest.id))"
        >
          {{ busyId === manifest.id ? "…" : isPluginEnabled(manifest.id) ? "停用" : "启用" }}
        </button>
      </li>
    </ul>

    <!-- 空清单：说明 + 恢复兜底（自锁死后唯一活路就在这个入口与回退页） -->
    <div v-else class="flex flex-col items-center gap-3 rounded-[12px] border border-dashed border-line-2 py-12 text-center">
      <span class="grid size-10 place-items-center rounded-[12px] bg-panel-2 text-dim">
        <Icon name="magic" :size="17" />
      </span>
      <p class="max-w-[380px] text-[12px] leading-relaxed text-dim2">{{ t("market.pluginsEmpty") }}</p>
      <button
        type="button"
        class="h-7 cursor-pointer rounded-[7px] bg-accent px-3 text-[12px] text-accent-ink transition-opacity hover:opacity-90"
        @click="restoreBuiltinPlugins()"
      >
        {{ t("market.restoreBuiltins") }}
      </button>
    </div>

    <p class="text-[11px] text-dim2">第三方插件由宿主代码调用 registerPlugin() 注册，本页即可启停。</p>
  </div>
</template>
