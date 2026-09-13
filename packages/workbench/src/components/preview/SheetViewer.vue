<script setup lang="ts">
/**
 * xlsx 预览：exceljs 读回 → Univer workbook 快照 → UniverSheetsCorePreset 渲染。
 * 转换在 `lib/univer-xlsx.ts`，生命周期在 `lib/univer-host.ts`。
 *
 * Univer 与其 CSS 全部动态 import：它是本仓最重的一组包，同步引会焊进主 chunk，
 * 让从不打开表格的用户也付启动代价（`PreviewSurface` 已按 kind 分包，这里别破坏它）。
 */
import { toRef } from "vue";
import { registerPresetPlugins, useUniverHost } from "../../lib/univer-host";
import { isDarkMode, watchTheme } from "../../lib/theme";
import type { PreviewTab } from "../../stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

const { host, loading, error, bootError } = useUniverHost(toRef(props, "tab"), async (container, bytes) => {
  const [
    { Univer, UniverInstanceType, LocaleType, ThemeService },
    { UniverSheetsCorePreset },
    { buildUniverLocaleConfig },
    { xlsxToUniverWorkbook },
  ] = await Promise.all([
    import("@univerjs/core"),
    import("@univerjs/preset-sheets-core"),
    import("../../lib/univer-locale"),
    import("../../lib/univer-xlsx"),
    import("@univerjs/preset-sheets-core/lib/index.css"),
  ]);

  const preset = UniverSheetsCorePreset({ container });
  const { locale, locales } = await buildUniverLocaleConfig();
  // preset 自带一份 locale，与我们加载的 zh-CN 合并；缺任一侧都会让部分 UI 回落成 key。
  const merged = {
    [LocaleType.ZH_CN]: { ...(locales[LocaleType.ZH_CN] ?? {}), ...(preset.locales?.[LocaleType.ZH_CN] ?? {}) },
  };

  const univer = new Univer({ locale, locales: merged, darkMode: isDarkMode() });
  registerPresetPlugins(univer, preset.plugins);
  univer.createUnit(UniverInstanceType.UNIVER_SHEET, await xlsxToUniverWorkbook(bytes));

  // 构造参数里的 darkMode 只管首帧：Univer 没有跟随宿主的配置项，切换外观只能事后
  // 推给它。ThemeService 是它自己的明暗真源，setDarkMode 会重刷 canvas 与 UI 皮肤，
  // 比销毁重建便宜得多（重建会丢滚动位置和选区）。
  const themeService = univer.__getInjector().get(ThemeService);
  const stopWatchTheme = watchTheme((theme) => themeService.setDarkMode(theme === "dark"));

  return {
    dispose: () => {
      stopWatchTheme();
      univer.dispose();
    },
  };
});
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">读取中…</p>
    <p v-else-if="error" role="alert" class="px-4 py-3 text-[12px] text-orange">读取失败：{{ error }}</p>
    <p v-else-if="bootError" role="alert" class="px-4 py-3 text-[12px] text-orange">
      无法渲染该表格：{{ bootError }}。可在文件夹中打开原文件。
    </p>
    <div v-show="!loading && !error && !bootError" ref="host" data-testid="sheet-viewer" class="min-h-0 flex-1" />
  </div>
</template>
