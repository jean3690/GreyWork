<script setup lang="ts">
/**
 * xlsx 预览：exceljs 读回 → Univer workbook 快照 → 手动组装的 Univer 插件集渲染。
 * 转换在 `lib/univer-xlsx.ts`，生命周期在 `lib/univer-host.ts`。
 *
 * Univer 与其 CSS 全部动态 import：它是本仓最重的一组包，同步引会焊进主 chunk，
 * 让从不打开表格的用户也付启动代价（`PreviewSurface` 已按 kind 分包，这里别破坏它）。
 *
 * 不用 `@univerjs/preset-sheets-core` 而手动注册插件：preset 无条件捆入公式三件套
 * （sheets-formula + engine-formula + sheets-formula-ui，源码约 9M）与 network/rpc。
 * **公式系在这里是故意保留的**：双击格子的内联输入由 `sheets-formula-ui` 提供
 * （官方 preset 是 sheets→sheets-ui→numfmt→numfmt-ui→formula→formula-ui 的注册顺序），
 * 少了它单元格就只能改到内容落不进去 —— 本次为了恢复「双击编辑」把它加回来了，
 * 代价是预览启动多拉 ~9M 的懒加载子包（只在打开预览 tab 时才 load，不影响主包体积）。
 * numfmt 两件套保留是刻意的：转换器写 `style.n` 的日期/数字 pattern，显示靠它。
 *
 * **只预览，不落盘**：保存功能已移除 —— Univer 表格里改的格子不会写回文件，也没有
 * 草稿 / 脏标记兜底，切 tab、关 tab 即丢弃。要真正编辑请用上方工具栏的「用系统应用打开」。
 */
import { computed, ref, toRef } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import { registerPresetPlugins, useUniverHost } from "@/lib/univer-host";
import { basename } from "@/lib/viewer";
import {
  formatRangeLabel,
  formatSelectionTsv,
  readRangeSelection,
  type RangeLike,
  type SheetLike,
  type SheetRangeSelection,
} from "@/lib/sheet-selection";
import { chatReceiverAvailable } from "@/lib/chat-receiver";
import { injectSelectionIntoChat, sheetSelectionPrompt } from "@/lib/selection-injection";
import { isDarkMode, watchTheme } from "@/lib/theme";
import type { IWorkbookData, Workbook } from "@univerjs/core";
import type { PreviewTab } from "@/stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

const { t } = useI18n();

/**
 * 读当前选区（boot 闭包写出，dispose 归零）。表格的选区只在 Univer 的模型里，DOM 拿不到。
 */
let readSelection: (() => SheetRangeSelection | null) | null = null;

/**
 * 当前选区标签（如 `Sheet1!A1:C3`），驱动「加入对话」按钮的可用态与提示。
 * 由选区命令刷新 —— Univer 的表格是 canvas 渲染，没有任何 DOM 事件可用。
 */
const selectionLabel = ref<string | null>(null);

const { host, loading, error, bootError } = useUniverHost(toRef(props, "tab"), async (container, bytes) => {
  const [
    { Univer, UniverInstanceType, ThemeService, ICommandService },
    { UniverDocsPlugin },
    { UniverRenderEnginePlugin },
    { UniverUIPlugin },
    { UniverDocsUIPlugin },
    { UniverSheetsPlugin, SheetsSelectionsService, SetSelectionsOperation },
    { UniverSheetsUIPlugin },
    { UniverSheetsNumfmtPlugin },
    { UniverSheetsNumfmtUIPlugin },
    { UniverSheetsFormulaPlugin },
    { UniverSheetsFormulaUIPlugin },
    { buildUniverLocaleConfig },
    { xlsxToUniverWorkbook },
  ] = await Promise.all([
    import("@univerjs/core"),
    import("@univerjs/docs"),
    import("@univerjs/engine-render"),
    import("@univerjs/ui"),
    import("@univerjs/docs-ui"),
    import("@univerjs/sheets"),
    import("@univerjs/sheets-ui"),
    import("@univerjs/sheets-numfmt"),
    import("@univerjs/sheets-numfmt-ui"),
    import("@univerjs/sheets-formula"),
    import("@univerjs/sheets-formula-ui"),
    import("@/lib/univer-locale"),
    import("@/lib/univer-xlsx"),
    // 子包样式合集，等价于已废弃的 preset index.css（原本少了 formula 系 UI 的样式）。
    import("@univerjs/design/lib/index.css"),
    import("@univerjs/ui/lib/index.css"),
    import("@univerjs/docs-ui/lib/index.css"),
    import("@univerjs/sheets-ui/lib/index.css"),
    import("@univerjs/sheets-numfmt-ui/lib/index.css"),
    import("@univerjs/sheets-formula-ui/lib/index.css"),
  ]);

  const { locale, locales } = await buildUniverLocaleConfig();
  const univer = new Univer({ locale, locales, darkMode: isDarkMode() });
  registerPresetPlugins(univer, [
    UniverDocsPlugin,
    UniverRenderEnginePlugin,
    [UniverUIPlugin, { container }],
    UniverDocsUIPlugin,
    UniverSheetsPlugin,
    UniverSheetsUIPlugin,
    UniverSheetsNumfmtPlugin,
    UniverSheetsNumfmtUIPlugin,
    UniverSheetsFormulaPlugin,
    UniverSheetsFormulaUIPlugin,
  ]);
  const workbook = univer.createUnit<IWorkbookData, Workbook>(UniverInstanceType.UNIVER_SHEET, await xlsxToUniverWorkbook(bytes));

  // 构造参数里的 darkMode 只管首帧：Univer 没有跟随宿主的配置项，切换外观只能事后
  // 推给它。ThemeService 是它自己的明暗真源，setDarkMode 会重刷 canvas 与 UI 皮肤，
  // 比销毁重建便宜得多（重建会丢滚动位置和选区）。
  const injector = univer.__getInjector();
  const themeService = injector.get(ThemeService);
  const stopWatchTheme = watchTheme((theme) => themeService.setDarkMode(theme === "dark"));

  // 选区只在 Univer 的模型里（表格是 canvas 渲染，DOM 上没有任何单元格节点），
  // 所以只能问它的选区服务。`primary` 非空的那条才是活动选区 —— 多选区时其余是陪衬。
  const selections = injector.get(SheetsSelectionsService);
  const activeSelection = (): { sheet: SheetLike; range: RangeLike } | null => {
    const active = selections.getCurrentSelections().find((candidate) => candidate.primary);
    const sheet = workbook.getActiveSheet(true);
    if (!active || !sheet) return null;
    return { sheet, range: active.range };
  };

  readSelection = () => {
    const found = activeSelection();
    if (!found) return null;
    return readRangeSelection(found.sheet, found.range);
  };

  const refreshSelectionLabel = (): void => {
    const found = activeSelection();
    selectionLabel.value = found ? formatRangeLabel(found.sheet.getName(), found.range) : null;
  };

  // 选区走 OPERATION（表格是 canvas 渲染，选区只在 Univer 的模型里）—— 所以刷新必须
  // 在这一层单独接，不能顺手塞进脏标记那条分支里（没有脏标记了，那条分支也不存在）。
  const subscription = injector.get(ICommandService).onCommandExecuted((info) => {
    if (info.id === SetSelectionsOperation.id) refreshSelectionLabel();
  });

  return {
    dispose: () => {
      subscription.dispose();
      stopWatchTheme();
      readSelection = null;
      selectionLabel.value = null;
      univer.dispose();
    },
  };
});

const name = computed(() => basename(props.tab.path));

/** 有接收方**且**确实选了一块区域，才允许加入对话。 */
const canSendSelection = computed(() => chatReceiverAvailable.value && selectionLabel.value !== null);

/** 禁用时要说清是哪个原因，不然用户只会觉得按钮坏了。 */
const selectionTitle = computed(() => {
  if (!chatReceiverAvailable.value) {
    return `${t("preview.selection.disabledNoReceiver")} · ${t("preview.selection.disabledHint")}`;
  }
  if (selectionLabel.value === null) return t("preview.selection.noRange");
  return `${selectionLabel.value} → ${t("preview.selection.addRange")}`;
});

/**
 * 把当前选区作为附件送进对话。
 *
 * 不用浮动浮层（正文那套）：表格是 canvas，浮层会和选区手柄、公式栏、右键菜单
 * 抢同一块位置，还会吞掉拖动选区所需的指针事件。放表头固定按钮零冲突。
 */
function sendSelectionToChat(): void {
  // 宿主接收端不可用时按钮只标 aria-disabled（保持可聚焦，提示里那句"为何不可用"才读得到），
  // 点击真正的兜底在这里。
  if (!chatReceiverAvailable.value) return;
  const selection = readSelection?.();
  if (!selection) return;
  injectSelectionIntoChat(sheetSelectionPrompt(), {
    selectionText: formatSelectionTsv(selection),
    unit: { role: "table-cell", level: null, listLevel: null, element: null, location: null },
    // 表格没有 DOM 作用域，也无从「向上找最近标题」——位置直接由范围标签给。
    scope: null,
    sourceName: props.tab.name,
    location: selection.label,
  });
}
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <Hint :text="tab.path" multiline>
        <span class="min-w-0 flex-1 truncate">{{ name }}</span>
      </Hint>
      <!-- 放在表头而非浮动浮层：表格是 canvas，浮层会与选区手柄 / 公式栏 / 右键菜单冲突 -->
      <Hint v-if="!loading && !error && !bootError" :text="selectionTitle" multiline>
        <button
          type="button"
          data-testid="sheet-send-to-chat"
          :aria-disabled="!canSendSelection || undefined"
          class="flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-[5px] border border-line-2 px-2 text-[11px] text-foreground transition-colors hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan aria-disabled:cursor-not-allowed aria-disabled:border-transparent aria-disabled:text-dim2 aria-disabled:hover:border-transparent aria-disabled:hover:text-dim2"
          @click="sendSelectionToChat()"
        >
          <Icon name="send-one" :size="11" />
          {{ t("preview.selection.addRange") }}
        </button>
      </Hint>
    </div>

    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">读取中…</p>
    <p v-else-if="error" role="alert" class="px-4 py-3 text-[12px] text-orange">读取失败：{{ error }}</p>
    <p v-else-if="bootError" role="alert" class="px-4 py-3 text-[12px] text-orange">
      无法渲染该表格：{{ bootError }}。可点上方工具栏的「用系统应用打开」看原文件。
    </p>
    <div v-show="!loading && !error && !bootError" ref="host" data-testid="sheet-viewer" class="min-h-0 flex-1" />
  </div>
</template>
