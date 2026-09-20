<script setup lang="ts">
/**
 * 老格式表格（`.xls` / `.xlt`）预览：宿主 calamine 解析 + 表格 / 分析双模式。
 *
 * **为什么走宿主**：`.xls` 是 OLE2/BIFF 二进制，渲染端没有任何解析器（exceljs / Univer
 * 都只认 xlsx）。宿主用 calamine 解析并按**内容**嗅探格式，因此扩展名被改错的 OOXML
 * 也能正确读出来 —— 比 `LegacyOfficeViewer` 那句「请改名」更进一步。
 *
 * **只支持磁盘来源**：宿主命令按路径读取并走路径授权，VFS 里的内存产物没有磁盘路径。
 * 应用自身也只产出 xlsx（`exportToXlsx`），所以这条分支在真实使用里不会出现，
 * 但仍然要给人话错误而不是静默失败。
 *
 * 选中的工作表由本组件持有（`sheet`），分析面板通过 `v-model:sheet` 共用 —— 否则面板
 * 只能从文件里再解析一次，且无从知道用户在表头选了哪张表。代价是分析模式下本组件与
 * 面板各读一次同一张表（宿主命令很便宜，换来的是切回表格时数据已经在手）。
 */
import { computed, defineAsyncComponent, ref, toRef } from "vue";
import { useI18n } from "vue-i18n";
import { isTauriRuntime } from "@greywork/core";
import GridTable from "@/features/preview/GridTable.vue";
import PreviewModeSwitch from "@/features/preview/PreviewModeSwitch.vue";
import Icon from "@/features/shared/Icon.vue";
import { openWithSystemApp, resolveTabDiskPath } from "@/lib/open-external";
import { usePreviewLoader } from "@/lib/preview-content";
import { readSheet } from "@/state/workspaceFiles";
import { notify } from "@/stores/notice";
import { usePreviewStore, type PreviewMode, type PreviewTab } from "@/stores/preview";
import type { SheetTable } from "@/lib/tabular";

const props = defineProps<{ tab: PreviewTab }>();

const { t } = useI18n();
const preview = usePreviewStore();

const AnalysisPanel = defineAsyncComponent(() => import("@/features/preview/DataAnalysisPanel.vue"));

/** 用户选中的工作表；null = 用文件里的首个。它进 watch 源，切换即重新解析。 */
const sheet = ref<string | null>(null);

const { data, loading, error } = usePreviewLoader<SheetTable>(
  toRef(props, "tab"),
  async (path) => {
    if (props.tab.source !== "disk") throw new Error(t("preview.xls.noDisk"));
    return readSheet(path, sheet.value ?? undefined);
  },
  [() => sheet.value],
);

const mode = computed<PreviewMode>(() => props.tab.mode ?? "table");
const header = computed(() => data.value?.rows[0] ?? []);
const body = computed(() => data.value?.rows.slice(1) ?? []);
const sheets = computed(() => data.value?.sheets ?? []);
const currentSheet = computed(() => data.value?.name ?? "");

function setMode(next: PreviewMode): void {
  preview.setMode(props.tab.id, next);
}

function onSheetChange(event: Event): void {
  sheet.value = (event.target as HTMLSelectElement).value;
}

/** 磁盘孪生路径；浏览器态恒为 null（没有磁盘通道，按钮留着只会点了没反应）。 */
const externalPath = computed(() => (isTauriRuntime() ? resolveTabDiskPath(props.tab) : null));

async function openExternal(): Promise<void> {
  const path = externalPath.value;
  if (!path) return;
  if (!(await openWithSystemApp(path))) {
    notify({
      kind: "warning",
      key: "legacy-sheet-open-external",
      title: t("preview.xls.openFailed"),
      detail: t("preview.xls.openFailedDetail", { path }),
    });
  }
}
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span class="min-w-0 flex-1 truncate">{{ tab.name }}</span>
      <!-- 分析模式下工作表选择器由面板自己带（同一份数据，两个选择器只会互相打架） -->
      <label v-if="mode === 'table' && sheets.length > 1" class="flex shrink-0 items-center gap-1">
        <span class="sr-only">{{ t("preview.analysis.sheet") }}</span>
        <select
          data-testid="legacy-sheet-select"
          class="h-5 cursor-pointer rounded-[5px] border border-line-2 bg-panel px-1 text-[11px] text-foreground"
          :value="currentSheet"
          @change="onSheetChange"
        >
          <option v-for="name in sheets" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <PreviewModeSwitch :model-value="mode" @update:model-value="setMode" />
    </div>

    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">{{ t("preview.common.loading") }}</p>

    <div v-else-if="error" class="min-h-0 flex-1 overflow-y-auto p-4" data-scroll-root>
      <p role="alert" class="text-[12px] text-orange">{{ t("preview.xls.readFailed", { detail: error }) }}</p>
      <p class="mt-2 text-[12px] leading-relaxed text-dim2">{{ t("preview.xls.fallback") }}</p>
      <button
        v-if="externalPath"
        type="button"
        data-testid="legacy-sheet-open-external"
        class="mt-3 flex cursor-pointer items-center gap-1 rounded-[8px] border border-line bg-panel px-3 py-1.5 text-[12px] text-dim transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
        @click="openExternal()"
      >
        <Icon name="external" :size="12" />
        {{ t("preview.xls.openExternal") }}
      </button>
    </div>

    <template v-else>
      <GridTable v-if="mode === 'table'" class="min-h-0 flex-1" test-id="legacy-sheet-viewer" :header="header" :rows="body" />
      <AnalysisPanel v-else v-model:sheet="sheet" class="min-h-0 flex-1" :tab="tab" />
    </template>
  </div>
</template>
