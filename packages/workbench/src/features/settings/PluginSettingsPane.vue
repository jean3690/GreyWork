<script setup lang="ts">
/**
 * 设置 · 插件配置：把已启用插件声明的 `settingsSchema` 渲染成表单。
 *
 * 值与插件的 `storage.kv` **共用同一份命名空间**（key 即字段 key）：插件代码里
 * `greywork.call("storage.kv", { op: "get", key })` 读到的就是这里写的值。
 * 不新建存储、也不做「设置页的副本」——副本迟早会和插件自己写的状态打架。
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { readPluginKv, writePluginKv } from "@/plugins/capabilities";
import { installedMarketPlugins } from "@/plugins/market";
import { isPluginEnabled } from "@/plugins/runtime";
import type { DeclarativeField } from "@/plugins/market-types";

const { t } = useI18n();

interface SettingsEntry {
  id: string;
  name: string;
  fields: DeclarativeField[];
}

/** 只列「启用中 + 声明了设置项」的插件：停用的插件不该还占着设置中心的位置。 */
const entries = computed<SettingsEntry[]>(() =>
  installedMarketPlugins.value
    .filter((pkg) => (pkg.manifest.contributes.settingsSchema?.length ?? 0) > 0 && isPluginEnabled(pkg.manifest.id))
    .map((pkg) => ({
      id: pkg.manifest.id,
      name: pkg.manifest.name,
      fields: pkg.manifest.contributes.settingsSchema ?? [],
    })),
);

/** KV 不是响应式对象：每次写入后自增，读值时依赖它。 */
const revision = ref(0);
const savedId = ref<string | null>(null);
const failed = ref<string | null>(null);
let savedTimer: ReturnType<typeof setTimeout> | undefined;

function valueOf(pluginId: string, field: DeclarativeField): string | number | boolean {
  void revision.value;
  const stored = readPluginKv(pluginId, field.key);
  if (field.kind === "toggle") return typeof stored === "boolean" ? stored : Boolean(field.default);
  if (field.kind === "number") return typeof stored === "number" ? stored : Number(field.default);
  return typeof stored === "string" ? stored : String(field.default);
}

function commit(pluginId: string, field: DeclarativeField, value: unknown): void {
  try {
    writePluginKv(pluginId, field.key, value);
    revision.value += 1;
    failed.value = null;
    savedId.value = pluginId;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      if (savedId.value === pluginId) savedId.value = null;
    }, 1500);
  } catch (error) {
    savedId.value = null;
    failed.value = error instanceof Error ? error.message : String(error);
  }
}

function onText(pluginId: string, field: DeclarativeField, event: Event): void {
  const raw = (event.target as HTMLInputElement).value;
  // 浏览器 maxlength 只管键盘输入，粘贴 / 程序化赋值仍可能超；这里再截一次。
  const value = field.maxLength ? raw.slice(0, field.maxLength) : raw;
  commit(pluginId, field, value);
}

function onNumber(pluginId: string, field: DeclarativeField, event: Event): void {
  const parsed = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(parsed)) {
    // 清空 / 非法输入：不写库，把控件恢复成当前值。
    (event.target as HTMLInputElement).value = String(valueOf(pluginId, field));
    return;
  }
  const clamped = Math.min(Math.max(parsed, field.min ?? parsed), field.max ?? parsed);
  commit(pluginId, field, clamped);
}

function onToggle(pluginId: string, field: DeclarativeField, event: Event): void {
  commit(pluginId, field, (event.target as HTMLInputElement).checked);
}
</script>

<template>
  <div data-testid="plugin-settings">
    <p v-if="!entries.length" class="text-[12px] text-dim2" data-testid="plugin-settings-empty">
      {{ t("settings.plugins.empty") }}
    </p>

    <article
      v-for="entry in entries"
      :key="entry.id"
      class="mb-4 rounded-[calc(12px*var(--gw-radius-scale))] border border-line bg-panel p-4"
      :data-testid="`plugin-settings-${entry.id}`"
    >
      <header class="flex items-baseline justify-between gap-2">
        <h2 class="text-[13px] font-semibold text-foreground">{{ entry.name }}</h2>
        <span class="font-mono text-[10px] text-dim2">{{ entry.id }}</span>
      </header>

      <div class="mt-3 space-y-3">
        <label v-for="field in entry.fields" :key="field.key" class="block" :data-testid="`plugin-setting-${entry.id}-${field.key}`">
          <span class="flex items-baseline justify-between gap-2">
            <span class="text-[12px] text-foreground">{{ field.label }}</span>
            <span class="text-right text-[10px] text-dim2">{{ field.description ?? "" }}</span>
          </span>

          <input
            v-if="field.kind === 'text'"
            type="text"
            class="mt-1 h-8 w-full rounded-[calc(7px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 text-[12px] text-foreground outline-none focus:border-line-2"
            :value="valueOf(entry.id, field)"
            :maxlength="field.maxLength"
            :data-field="field.key"
            @change="onText(entry.id, field, $event)"
          />
          <input
            v-else-if="field.kind === 'number'"
            type="number"
            class="mt-1 h-8 w-full rounded-[calc(7px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 text-[12px] text-foreground outline-none focus:border-line-2"
            :value="valueOf(entry.id, field)"
            :min="field.min"
            :max="field.max"
            :step="field.step"
            :data-field="field.key"
            @change="onNumber(entry.id, field, $event)"
          />
          <input
            v-else
            type="checkbox"
            class="mt-1 size-4 accent-cyan"
            :checked="Boolean(valueOf(entry.id, field))"
            :data-field="field.key"
            @change="onToggle(entry.id, field, $event)"
          />
        </label>
      </div>

      <p v-if="savedId === entry.id" class="mt-2 text-[10.5px] text-ok" data-testid="plugin-settings-saved">
        {{ t("settings.plugins.saved") }}
      </p>
    </article>

    <p v-if="failed" class="mt-2 text-[11px] text-danger" data-testid="plugin-settings-error">
      {{ t("settings.plugins.failed", { message: failed }) }}
    </p>
  </div>
</template>
