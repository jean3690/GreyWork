<script setup lang="ts">
/**
 * docx 预览：解压 OOXML → Univer 文档快照 → UniverDocsCorePreset 渲染。
 * 转换在 `lib/univer-docx.ts`（正则解析，非 DOMParser，保证 Node 下可单测）。
 *
 * 定位是**基础视觉还原**而非像素级保真：Univer 前端没有原生 docx 导入，段落/加粗/
 * 字号/对齐这些拿得到，复杂版式（分栏、浮动图、表格样式）不保证。
 */
import { toRef } from "vue";
import { isDarkMode, registerPresetPlugins, useUniverHost } from "../../lib/univer-host";
import type { PreviewTab } from "../../stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

const { host, loading, error, bootError } = useUniverHost(toRef(props, "tab"), async (container, bytes) => {
  const [{ Univer, UniverInstanceType, LocaleType }, { UniverDocsCorePreset }, { buildUniverLocaleConfig }, { docxToUniverDocument }] =
    await Promise.all([
      import("@univerjs/core"),
      import("@univerjs/preset-docs-core"),
      import("../../lib/univer-locale"),
      import("../../lib/univer-docx"),
      import("@univerjs/preset-docs-core/lib/index.css"),
    ]);

  const preset = UniverDocsCorePreset({ container });
  const { locale, locales } = await buildUniverLocaleConfig(true, false);
  const merged = {
    [LocaleType.ZH_CN]: { ...(locales[LocaleType.ZH_CN] ?? {}), ...(preset.locales?.[LocaleType.ZH_CN] ?? {}) },
  };

  const univer = new Univer({ locale, locales: merged, darkMode: isDarkMode() });
  registerPresetPlugins(univer, preset.plugins);
  univer.createUnit(UniverInstanceType.UNIVER_DOC, await docxToUniverDocument(bytes));

  return { dispose: () => univer.dispose() };
});
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">读取中…</p>
    <p v-else-if="error" role="alert" class="px-4 py-3 text-[12px] text-red-400">读取失败：{{ error }}</p>
    <p v-else-if="bootError" role="alert" class="px-4 py-3 text-[12px] text-red-400">
      无法渲染该文档：{{ bootError }}。可在文件夹中打开原文件。
    </p>
    <div v-show="!loading && !error && !bootError" ref="host" data-testid="doc-viewer" class="min-h-0 flex-1" />
  </div>
</template>
