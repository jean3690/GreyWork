<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import ExcelJS from "exceljs";
import { FileSpreadsheet, FileText, Presentation, X } from "lucide-vue-next";
import MarkdownText from "../MarkdownText.vue";
import { useVfsStore } from "../../stores/vfs";
import { appEvents } from "../../events";
import { basename, kindOfPath, type ViewerKind } from "../../lib/viewer";
import { useI18n } from "vue-i18n";

const vfs = useVfsStore();
const { t } = useI18n();

interface XlsxSheetView {
  name: string;
  headers: string[];
  rows: string[][];
}

/** 一个产物预览场景（tab）。 */
interface ViewerTab {
  id: string; // path
  title: string;
  path: string;
  kind: ViewerKind;
  /** 文本内容（md/html/csv/raw）。 */
  text?: string;
  /** docx 经 mammoth 转换的 HTML（沙箱 iframe 渲染）。 */
  html?: string;
  /** xlsx 读回的 sheet 表格。 */
  xlsx?: XlsxSheetView[];
  busy?: boolean;
  error?: string;
}

const tabs = ref<ViewerTab[]>([]);
const activeTabId = ref("");

/** 沙箱默认禁脚本/禁同源；勾选后放行脚本（仍禁同源）。 */
const allowScripts = ref(false);
const sandbox = computed(() => (allowScripts.value ? "allow-scripts" : ""));

const activeTab = ref<ViewerTab | null>(null);
function refreshActive(): void {
  activeTab.value = tabs.value.find((tab) => tab.id === activeTabId.value) ?? null;
}

async function loadXlsx(tab: ViewerTab): Promise<void> {
  tab.busy = true;
  try {
    const data = await vfs.readBinary(tab.path);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(data as unknown as ArrayBuffer);
    tab.xlsx = workbook.worksheets.map((sheet) => {
      const rows: string[][] = [];
      sheet.eachRow({ includeEmpty: true }, (row) => {
        const values = (row.values as unknown[]).slice(1).map((cell) => (cell == null ? "" : String(cell)));
        rows.push(values);
      });
      return { name: sheet.name, headers: rows[0] ?? [], rows: rows.slice(1) };
    });
  } catch (error) {
    tab.error = error instanceof Error ? error.message : String(error);
  } finally {
    tab.busy = false;
  }
}

/** docx → HTML（mammoth，懒加载 browser bundle；转换结果入沙箱 iframe 渲染）。 */
async function loadDocx(tab: ViewerTab): Promise<void> {
  tab.busy = true;
  try {
    const data = await vfs.readBinary(tab.path);
    const { convertToHtml } = await import("mammoth");
    const view = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const result = await convertToHtml({ arrayBuffer: view });
    tab.html = result.value;
  } catch (error) {
    tab.error = error instanceof Error ? error.message : String(error);
  } finally {
    tab.busy = false;
  }
}

/** 打开产物（VFS 路径）：已开则聚焦，未开则建 tab 并懒加载内容。 */
async function openPath(path: string): Promise<void> {
  if (!path) return;
  const existing = tabs.value.find((tab) => tab.path === path);
  if (existing) {
    activeTabId.value = existing.id;
    refreshActive();
    return;
  }
  const kind = kindOfPath(path);
  const tab: ViewerTab = { id: path, title: basename(path), path, kind };
  tabs.value.push(tab);
  activeTabId.value = path;
  refreshActive();
  if (kind === "xlsx") {
    await loadXlsx(tab);
  } else if (kind === "docx") {
    await loadDocx(tab);
  } else if (kind === "pptx") {
    // 二进制演示文稿：占位（下载走交付物面板）
  } else {
    tab.text = await vfs.readFile(path);
  }
}

function closeTab(id: string): void {
  const index = tabs.value.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  tabs.value.splice(index, 1);
  if (activeTabId.value === id) {
    activeTabId.value = tabs.value[index - 1]?.id ?? tabs.value[0]?.id ?? "";
    refreshActive();
  }
}

/* 订阅：产物创建自动开 tab；preview:request 聚焦指定产物。 */
const unsubscribeArtifact = appEvents.on("artifact:created", ({ path }) => void openPath(path));
const unsubscribePreview = appEvents.on("preview:request", ({ path }) => void openPath(path));
onUnmounted(() => {
  unsubscribeArtifact();
  unsubscribePreview();
});

/* 空态引导：复用 WebPreviewPane 的载入示例产物。 */
async function loadSample(): Promise<void> {
  const path = "reports/genui/sample.html";
  const sample = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><style>
  body { margin:0; padding:24px; font-family: ui-sans-serif, system-ui, "Noto Sans SC", sans-serif; background:#fafaf9; color:#292524; }
  h1 { font-size:20px; }
  .kpis { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
  .kpi { background:#fff; border:1px solid #e7e5e4; border-radius:10px; padding:12px; }
  .kpi b { display:block; font-size:22px; }
  .kpi span { color:#a8a29e; font-size:11px; }
</style></head>
<body><h1>示例看板</h1><div class="kpis">
  <div class="kpi"><span>总客流</span><b>12,384</b></div>
  <div class="kpi"><span>环比</span><b>+8.2%</b></div>
  <div class="kpi"><span>峰值日</span><b>周六</b></div>
</div></body></html>`;
  await vfs.write(path, sample);
  await openPath(path);
}
</script>

<template>
  <div class="side__pane viewer">
    <div v-if="tabs.length" class="viewer__bar">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="viewer__tab"
        :class="{ active: tab.id === activeTabId }"
        :title="tab.path"
        @click="
          activeTabId = tab.id;
          refreshActive();
        "
      >
        <component :is="tab.kind === 'xlsx' ? FileSpreadsheet : tab.kind === 'pptx' ? Presentation : FileText" class="size-3" />
        <span class="viewer__tab-name">{{ tab.title }}</span>
        <i class="viewer__tab-x" :title="t('panels.viewer.closeTab')" @click.stop="closeTab(tab.id)"><X class="size-2.5" /></i>
      </button>
      <label v-if="activeTab?.kind === 'html'" class="viewer__script" :title="t('panels.preview.scriptWarning')">
        <input v-model="allowScripts" type="checkbox" />
        <span>{{ t("panels.preview.allowScripts") }}</span>
      </label>
    </div>

    <div v-if="activeTab" :key="activeTab.id" class="viewer__body">
      <p v-if="activeTab.busy" class="footnote">{{ t("panels.viewer.loading") }}</p>
      <p v-else-if="activeTab.error" class="footnote">{{ t("panels.viewer.error", { detail: activeTab.error }) }}</p>

      <div v-else-if="activeTab.kind === 'html'" class="viewer__frame-wrap">
        <iframe class="viewer__frame" :srcdoc="activeTab.text" :sandbox="sandbox" :title="activeTab.title"></iframe>
      </div>

      <div v-else-if="activeTab.kind === 'docx'" class="viewer__frame-wrap">
        <iframe class="viewer__frame" :srcdoc="activeTab.html" :sandbox="sandbox" :title="activeTab.title"></iframe>
      </div>

      <div v-else-if="activeTab.kind === 'md'" class="viewer__md">
        <MarkdownText :content="activeTab.text ?? ''" />
      </div>

      <div v-else-if="activeTab.kind === 'csv'" class="viewer__table">
        <table>
          <thead>
            <tr>
              <th v-for="(cell, i) in activeTab.text?.trimEnd().split('\n')[0]?.split(',') ?? []" :key="i">{{ cell }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, i) in (activeTab.text ?? '')
                .trimEnd()
                .split('\n')
                .slice(1)
                .map((line) => line.split(','))"
              :key="i"
            >
              <td v-for="(cell, j) in row" :key="j">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else-if="activeTab.kind === 'xlsx'" class="viewer__table">
        <section v-for="sheet in activeTab.xlsx" :key="sheet.name" class="viewer__sheet">
          <p class="viewer__sheet-name">{{ sheet.name }}</p>
          <table>
            <thead>
              <tr>
                <th v-for="(cell, i) in sheet.headers" :key="i">{{ cell }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in sheet.rows" :key="i">
                <td v-for="(cell, j) in row" :key="j">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <div v-else-if="activeTab.kind === 'pptx'" class="viewer__placeholder">
        <Presentation class="size-4" />
        <span>{{ t("panels.viewer.binaryPlaceholder", { name: activeTab.title }) }}</span>
      </div>

      <pre v-else class="viewer__raw">{{ activeTab.text }}</pre>
    </div>

    <div v-else class="viewer__empty">
      <p>{{ t("panels.viewer.empty") }}</p>
      <button class="btn btn--mini" @click="loadSample">{{ t("panels.preview.loadSample") }}</button>
    </div>
  </div>
</template>

<style scoped>
.viewer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
.viewer__bar {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  padding-bottom: 2px;
}
.viewer__tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  max-width: 180px;
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-2);
  color: var(--dim);
  font-size: 11px;
  cursor: pointer;
  transition: 0.15s;
}
.viewer__tab.active {
  background: var(--accent);
  color: var(--accent-ink);
  border-color: transparent;
  font-weight: 600;
}
.viewer__tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.viewer__tab-x {
  display: inline-grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border-radius: 4px;
  opacity: 0.6;
}
.viewer__tab-x:hover {
  background: rgba(127, 127, 127, 0.25);
  opacity: 1;
}
.viewer__script {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  color: var(--dim);
  font-size: 11px;
  white-space: nowrap;
}
.viewer__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
}
.viewer__frame-wrap {
  height: 100%;
  min-height: 340px;
}
.viewer__frame {
  width: 100%;
  height: 100%;
  min-height: 340px;
  border: none;
  border-radius: 9px;
  background: #fff;
}
.viewer__md {
  padding: 14px;
  font-size: 12.5px;
}
.viewer__table {
  padding: 12px;
  overflow: auto;
}
.viewer__table table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}
.viewer__table th,
.viewer__table td {
  padding: 6px 9px;
  border-bottom: 1px solid var(--line);
  text-align: left;
}
.viewer__table th {
  color: var(--text);
  font-weight: 600;
  background: var(--panel-2);
}
.viewer__sheet-name {
  margin: 10px 0 6px;
  color: var(--dim);
  font-family: var(--font-mono);
  font-size: 11px;
}
.viewer__placeholder {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px;
  color: var(--dim);
  font-size: 12.5px;
}
.viewer__raw {
  margin: 0;
  padding: 14px;
  color: var(--dim);
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: pre-wrap;
}
.viewer__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex: 1;
  min-height: 260px;
  color: var(--dim2);
  font-size: 12.5px;
  text-align: center;
}
</style>
