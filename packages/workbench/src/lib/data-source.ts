/**
 * 分析面板的数据来源：把三条通道收口成一个 `DataTable`。
 *
 * - CSV → 前端 `parseCsv`（文本，VFS 与磁盘都支持）
 * - xlsx → 前端 exceljs（二进制，VFS 与磁盘都支持）
 * - xls → 宿主 calamine 命令（只支持磁盘）
 *
 * **为什么 xlsx 不也走宿主**：VFS 里的管线产物只有 xlsx（`exportXlsx` 产出），必须能分析；
 * 而 exceljs 已经是本仓 xlsx 语义的唯一真源（`xlsx-values` / `xlsx-sanitize`）。若再让
 * calamine 也读 xlsx，同一份文件会出现两套取值口径（日期、公式缓存的解释未必一致），
 * 而一个文件只会命中其中一条通道，双解析器带来的只有风险没有收益。
 */

import { computed, type Ref } from "vue";
import { readPreviewBinary, readPreviewText, usePreviewLoader, type PreviewContent } from "./preview-content";
import { parseCsv } from "./csv";
import { readXlsxTable } from "./xlsx";
import { toDataTable, type DataTable, type SheetTable } from "./tabular";
import { readSheet } from "../state/workspaceFiles";
import type { PreviewTab } from "../stores/preview";

/**
 * 读取当前 tab 的表格数据。
 *
 * `sheet` 是「当前选中的工作表名」的 getter（null = 默认首个）；它进 watch 源，所以切换
 * 工作表会重新加载。用 getter 而不是 `Ref`：调用点既有本地 ref 也有 `defineModel` 的
 * 双向绑定 ref，两者类型不同，收成一个取值函数就不必为类型做适配。
 * 返回的 `data` 已经过 `toDataTable`（首行当表头 + 列类型推断），组件不必再碰原始网格。
 */
export function useDataTable(tab: Ref<PreviewTab>, sheet: () => string | null): PreviewContent<DataTable> {
  const content = usePreviewLoader<SheetTable>(
    tab,
    async (path) => {
      const current = tab.value;
      const wanted = sheet() ?? undefined;
      if (current.kind === "csv") {
        // CSV 没有工作表概念：sheets 留空，分析面板据此隐藏工作表选择器。
        return { sheets: [], name: "", rows: parseCsv(await readPreviewText(current, path)), truncated: false };
      }
      if (current.kind === "xlsx") {
        return readXlsxTable(await readPreviewBinary(current, path), wanted);
      }
      if (current.kind === "xls") {
        // 宿主命令按路径读并走路径授权；内存产物没有磁盘路径，这条通道走不通。
        if (current.source !== "disk") throw new Error("内存里的产物没有 .xls，无法分析");
        return readSheet(path, wanted);
      }
      throw new Error(`${current.kind} 不是表格类型，无法分析`);
    },
    [sheet],
  );

  const table = computed(() => (content.data.value ? toDataTable(content.data.value) : null));
  return { data: table, loading: content.loading, error: content.error };
}
