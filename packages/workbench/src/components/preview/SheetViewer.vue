<script setup lang="ts">
/**
 * xlsx 预览 + 编辑：exceljs 读回 → Univer workbook 快照 → 手动组装的 Univer 插件集渲染。
 * 转换在 `lib/univer-xlsx.ts`，生命周期在 `lib/univer-host.ts`，回写在 `lib/univer-xlsx-write.ts`。
 *
 * Univer 与其 CSS 全部动态 import：它是本仓最重的一组包，同步引会焊进主 chunk，
 * 让从不打开表格的用户也付启动代价（`PreviewSurface` 已按 kind 分包，这里别破坏它）。
 *
 * 不用 `@univerjs/preset-sheets-core` 而手动注册插件：preset 无条件捆入公式三件套
 * （sheets-formula + engine-formula + sheets-formula-ui，源码约 9M）与 network/rpc，
 * 而本预览只读 —— 数值由 exceljs 从缓存值读出，转换器从不写公式，公式引擎纯死重。
 * numfmt 两件套保留是刻意的：转换器写 `style.n` 的日期/数字 pattern，显示靠它。
 *
 * **可编辑但只回写单元格内容**：Univer 的表格 UI 默认就能改，改动落在它自己的数据模型里；
 * 保存时按「原始字节 + 基准快照 → 当前快照」的差量写回（见 `lib/univer-xlsx-write.ts` 的立场）。
 * 格式 / 合并 / 行列尺寸 / 增删工作表这些不落盘，所以 header 上有明说，别让用户以为保存是全量的。
 *
 * **未保存的工作在挂载期之外也不会丢**：切 tab / 切到文件区 / 重载都会销毁本组件（`PreviewSurface`
 * 只挂载激活 tab），所以卸载时把「原始字节 + 基准快照 + 当前快照」整条记录交给
 * `lib/sheet-draft.ts`，下次挂载原样接着改。关 tab 才需要用户确认，不打断切换。
 */
import { computed, ref, toRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";
import { registerPresetPlugins, useUniverHost } from "../../lib/univer-host";
import { applyUniverEdits } from "../../lib/univer-xlsx-write";
import { hasGraphicsParts } from "../../lib/xlsx-sanitize";
import { basename } from "../../lib/viewer";
import { readSheetDraft, stashSheetDraft, dropSheetDraft } from "../../lib/sheet-draft";
import {
  formatRangeLabel,
  formatSelectionTsv,
  readRangeSelection,
  type RangeLike,
  type SheetLike,
  type SheetRangeSelection,
} from "../../lib/sheet-selection";
import { chatReceiverAvailable } from "../../lib/chat-receiver";
import { injectSelectionIntoChat, sheetSelectionPrompt } from "../../lib/selection-injection";
import { isDarkMode, watchTheme } from "../../lib/theme";
import { writeBinaryFile } from "../../state/workspaceFiles";
import { useVfsStore } from "../../stores/vfs";
import { usePreviewStore } from "../../stores/preview";
import { notify } from "../../stores/notice";
import type { IWorkbookData, Workbook } from "@univerjs/core";
import type { PreviewTab } from "../../stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

const { t } = useI18n();
const vfs = useVfsStore();
const preview = usePreviewStore();

/** 有未保存改动；由命令监听到 MUTATION 时置起。 */
const dirty = ref(false);
const saving = ref(false);
/** 最近一次保存成功（新改动到达即清掉）。 */
const saved = ref(false);

/**
 * boot 闭包写出的句柄，dispose 时归零。
 *
 * `useUniverHost` 的 boot 契约只回 `{ dispose }`，而这些句柄要在 boot 之后（保存时）才用得上，
 * 所以挂在 setup 作用域上而不是往宿主接口里加字段 —— 那会让另外两个 viewer 也背上无用参数。
 */
let readSnapshot: (() => IWorkbookData) | null = null;
let baseSnapshot: IWorkbookData | null = null;
/** 打开时的原始字节；每保存一次换成新字节，下一轮 diff 才有正确的底。 */
let sourceBytes: Uint8Array | null = null;
/** 读当前选区（boot 闭包写出，dispose 归零）。表格的选区只在 Univer 的模型里，DOM 拿不到。 */
let readSelection: (() => SheetRangeSelection | null) | null = null;

/**
 * 当前选区标签（如 `Sheet1!A1:C3`），驱动「加入对话」按钮的可用态与提示。
 * 由选区命令刷新 —— Univer 的表格是 canvas 渲染，没有任何 DOM 事件可用。
 */
const selectionLabel = ref<string | null>(null);

/** 脏标记双向同步：本地 ref 驱动保存按钮，store 那份驱动 tab 上的圆点与关闭前的确认。 */
watch(dirty, (value) => preview.setDirty(props.tab.id, value));

const { host, loading, error, bootError } = useUniverHost(toRef(props, "tab"), async (container, bytes) => {
  // 有草稿就在它上面继续改，连文件都不必重新解析（省一次 exceljs + 规范化）。
  const draft = readSheetDraft(props.tab.id);
  const [
    { Univer, UniverInstanceType, ThemeService, CommandType, ICommandService },
    { UniverDocsPlugin },
    { UniverRenderEnginePlugin },
    { UniverUIPlugin },
    { UniverDocsUIPlugin },
    { UniverSheetsPlugin, SheetsSelectionsService, SetSelectionsOperation },
    { UniverSheetsUIPlugin },
    { UniverSheetsNumfmtPlugin },
    { UniverSheetsNumfmtUIPlugin },
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
    import("../../lib/univer-locale"),
    import("../../lib/univer-xlsx"),
    // 子包样式合集，等价于已废弃的 preset index.css（少了 formula 系 UI 的样式）。
    import("@univerjs/design/lib/index.css"),
    import("@univerjs/ui/lib/index.css"),
    import("@univerjs/docs-ui/lib/index.css"),
    import("@univerjs/sheets-ui/lib/index.css"),
    import("@univerjs/sheets-numfmt-ui/lib/index.css"),
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
  ]);
  const workbook = univer.createUnit<IWorkbookData, Workbook>(
    UniverInstanceType.UNIVER_SHEET,
    draft ? draft.current : await xlsxToUniverWorkbook(bytes),
  );

  // 构造参数里的 darkMode 只管首帧：Univer 没有跟随宿主的配置项，切换外观只能事后
  // 推给它。ThemeService 是它自己的明暗真源，setDarkMode 会重刷 canvas 与 UI 皮肤，
  // 比销毁重建便宜得多（重建会丢滚动位置和选区）。
  const injector = univer.__getInjector();
  const themeService = injector.get(ThemeService);
  const stopWatchTheme = watchTheme((theme) => themeService.setDarkMode(theme === "dark"));

  // 基准快照必须**此刻**取：Univer 建单元时会规范化（补行列数、重排样式 id、丢空格），
  // 拿转换器的输出当基准，保存时的 diff 会全是噪音。有草稿就用草稿自带的基准，
  // 它与 current 同源同规范化，差量才对得上。
  baseSnapshot = draft ? draft.base : workbook.getSnapshot();
  sourceBytes = draft ? draft.source : bytes;
  readSnapshot = () => workbook.getSnapshot();
  dirty.value = draft !== null;
  saved.value = false;

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

  // 选区走 OPERATION，而下面只认 MUTATION 来标脏 —— 所以选区刷新必须在这一层单独接，
  // 不能顺手塞进脏标记那条分支里（它会把选区变化也当改动）。
  const subscription = injector.get(ICommandService).onCommandExecuted((info) => {
    if (info.id === SetSelectionsOperation.id) {
      refreshSelectionLabel();
      return;
    }
    if (info.type !== CommandType.MUTATION) return;
    dirty.value = true;
    saved.value = false;
  });

  return {
    dispose: () => {
      subscription.dispose();
      stopWatchTheme();
      // 先把未保存的工作交接出去，再放掉句柄和实例 —— 顺序反了就取不到快照了。
      // 脏标记**不回写 store**：有未保存改动这件事与组件是否挂载无关，切回来还要用。
      if (dirty.value && readSnapshot && baseSnapshot && sourceBytes) {
        stashSheetDraft(props.tab.id, { base: baseSnapshot, current: readSnapshot(), source: sourceBytes });
      } else {
        dropSheetDraft(props.tab.id);
      }
      readSnapshot = null;
      baseSnapshot = null;
      sourceBytes = null;
      readSelection = null;
      selectionLabel.value = null;
      saved.value = false;
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
  const selection = readSelection?.();
  if (!selection) return;
  injectSelectionIntoChat(sheetSelectionPrompt(), {
    selectionText: formatSelectionTsv(selection),
    unit: { role: "table-cell", level: null, listLevel: null, element: null },
    // 表格没有 DOM 作用域，也无从「向上找最近标题」——位置直接由范围标签给。
    scope: null,
    sourceName: props.tab.name,
    location: selection.label,
  });
}

/** 保存：差量回写原文件。磁盘源写磁盘，产物写回 VFS（同时落盘的那份由 deliverArtifact 管）。 */
async function save(): Promise<void> {
  const current = readSnapshot?.();
  const base = baseSnapshot;
  const original = sourceBytes;
  if (!current || !base || !original || saving.value) return;
  saving.value = true;
  try {
    const bytes = await applyUniverEdits(original, base, current);
    // 含图表/图片的工作簿经 exceljs 重写会丢这些部件，保存前先探一次好如实告知
    const losesGraphics = await hasGraphicsParts(original);
    if (props.tab.source === "disk") await writeBinaryFile(props.tab.path, bytes);
    else await vfs.writeBinary(props.tab.path, bytes);
    baseSnapshot = current;
    sourceBytes = bytes;
    // 落盘了，草稿没用了；留着它会让下次挂载把已写回的改动又当未保存的还原一遍
    dropSheetDraft(props.tab.id);
    dirty.value = false;
    saved.value = true;
    if (losesGraphics) {
      notify({
        kind: "warning",
        key: "sheet-save-graphics",
        title: "图表 / 图片未被保留",
        detail: "这份表格含图表或图片，保存后这些内容会丢失。需要保留请改用上方「用系统应用打开」。",
      });
    }
  } catch (cause: unknown) {
    notify({
      kind: "error",
      key: "sheet-save",
      title: "保存失败",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span class="min-w-0 flex-1 truncate" :title="tab.path">{{ name }}</span>
      <span v-if="dirty" class="shrink-0 text-cyan">未保存</span>
      <span v-else-if="saved" class="shrink-0">已保存</span>
      <!-- 放在表头而非浮动浮层：表格是 canvas，浮层会与选区手柄 / 公式栏 / 右键菜单冲突 -->
      <button
        v-if="!loading && !error && !bootError"
        type="button"
        data-testid="sheet-send-to-chat"
        :disabled="!canSendSelection"
        :title="selectionTitle"
        class="flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-[5px] border border-line-2 px-2 text-[11px] text-foreground transition-colors hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:border-transparent disabled:text-dim2 disabled:hover:border-transparent disabled:hover:text-dim2"
        @click="sendSelectionToChat()"
      >
        <Icon name="send-one" :size="11" />
        {{ t("preview.selection.addRange") }}
      </button>
      <button
        type="button"
        data-testid="sheet-save"
        :disabled="!dirty || saving"
        :title="dirty ? '把单元格内容与公式写回原文件' : '没有需要保存的改动'"
        class="flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-[5px] bg-cyan/15 px-2 text-[11px] text-cyan transition-colors hover:bg-cyan/25 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:bg-transparent disabled:text-dim2"
        @click="save()"
      >
        <Icon name="save" :size="11" />
        {{ saving ? "保存中…" : "保存" }}
      </button>
    </div>

    <p class="shrink-0 px-3 pb-1 text-[10.5px] text-dim2">
      保存只回写单元格内容与公式；格式、合并单元格等改动不会保存，需要请用系统应用打开。
    </p>

    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">读取中…</p>
    <p v-else-if="error" role="alert" class="px-4 py-3 text-[12px] text-orange">读取失败：{{ error }}</p>
    <p v-else-if="bootError" role="alert" class="px-4 py-3 text-[12px] text-orange">
      无法渲染该表格：{{ bootError }}。可点上方工具栏的「用系统应用打开」看原文件。
    </p>
    <div v-show="!loading && !error && !bootError" ref="host" data-testid="sheet-viewer" class="min-h-0 flex-1" />
  </div>
</template>
