<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { FileSpreadsheet, FileText, Presentation, X } from "lucide-vue-next";
import MarkdownText from "../MarkdownText.vue";
import { useVfsStore } from "../../stores/vfs";
import { appEvents } from "../../events";
import { basename, kindOfPath, type ViewerKind } from "../../lib/viewer";
import type { IDocumentData, IWorkbookData } from "@univerjs/core";
import type { ISlideData } from "@univerjs/slides";
import { useI18n } from "vue-i18n";
import { buildUniverLocaleConfig } from "../../lib/univer-locale";
import type { Plugin, PluginCtor } from "@univerjs/core";

const vfs = useVfsStore();
const { t } = useI18n();

/** 一个产物预览场景（tab）。 */
interface ViewerTab {
  id: string; // path
  title: string;
  path: string;
  kind: ViewerKind;
  /** 文本内容（md/html/csv/raw）。 */
  text?: string;
  /** xlsx 转 Univer workbook 快照（视觉渲染）。 */
  univerData?: IWorkbookData;
  /** docx 转 Univer 文档快照（视觉渲染）。 */
  docData?: IDocumentData;
  /** pptx 转 Univer 幻灯片快照（视觉渲染）。 */
  slideData?: ISlideData;
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

/**
 * xlsx/docx/pptx → Univer 视觉渲染（懒加载独立 chunk；每次切 tab 重建实例并 dispose 旧实例）。
 * xlsx/docx 使用对应 preset；pptx 使用插件模式（Univer 无 slides preset）。
 */
const univerHost = ref<HTMLElement | null>(null);
let univerInstance: { dispose: () => void } | null = null;
/** 渲染纪元：每次 renderUniver 递增；异步导入完成后纪元不匹配则丢弃（防快速切 tab 的竞态）。 */
let renderEpoch = 0;

async function renderUniver(tab: ViewerTab): Promise<void> {
  const epoch = ++renderEpoch;
  univerInstance?.dispose();
  univerInstance = null;
  await nextTick();
  if (epoch !== renderEpoch) return;
  if (!univerHost.value) return;

  if (tab.kind === "xlsx" && tab.univerData) {
    try {
      const [{ Univer, UniverInstanceType }, { UniverSheetsCorePreset }] = await Promise.all([
        import("@univerjs/core"),
        import("@univerjs/preset-sheets-core"),
      ]);
      await import("@univerjs/preset-sheets-core/lib/index.css");
      if (epoch !== renderEpoch) return;
      const el = univerHost.value as HTMLElement;
      const univer = new Univer(await buildUniverLocaleConfig(false, true));
      univer.registerPlugins(
        UniverSheetsCorePreset({ container: el }).plugins.map((p: PluginCtor<Plugin> | [PluginCtor<Plugin>, unknown]) =>
          Array.isArray(p) ? p : [p, void 0],
        ),
      );
      univer.createUnit(UniverInstanceType.UNIVER_SHEET, tab.univerData);
      if (epoch !== renderEpoch) {
        univer.dispose();
        return;
      }
      univerInstance = univer;
    } catch (e) {
      console.error("[renderUniver] xlsx render ERROR", e);
    }
    return;
  }
  if (tab.kind === "docx" && tab.docData) {
    try {
      const [{ Univer, UniverInstanceType }, { UniverDocsCorePreset }] = await Promise.all([
        import("@univerjs/core"),
        import("@univerjs/preset-docs-core"),
      ]);
      await import("@univerjs/preset-docs-core/lib/index.css");
      if (epoch !== renderEpoch) return;
      const el = univerHost.value as HTMLElement;
      const univer = new Univer(await buildUniverLocaleConfig(true));
      univer.registerPlugins(
        UniverDocsCorePreset({ container: el }).plugins.map((p: PluginCtor<Plugin> | [PluginCtor<Plugin>, unknown]) =>
          Array.isArray(p) ? p : [p, void 0],
        ),
      );
      univer.createUnit(UniverInstanceType.UNIVER_DOC, tab.docData);
      if (epoch !== renderEpoch) {
        univer.dispose();
        return;
      }
      univerInstance = univer;
    } catch (e) {
      console.error("[renderUniver] docx render ERROR", e);
    }
    return;
  }

  if (tab.kind === "pptx" && tab.slideData) {
    try {
      const [
        { Univer, UniverInstanceType },
        { UniverRenderEnginePlugin },
        { UniverUIPlugin },
        { UniverDocsPlugin },
        { UniverSlidesPlugin },
        { UniverSlidesUIPlugin },
        { UniverDocsUIPlugin },
      ] = await Promise.all([
        import("@univerjs/core"),
        import("@univerjs/engine-render"),
        import("@univerjs/ui"),
        import("@univerjs/docs"),
        import("@univerjs/slides"),
        import("@univerjs/slides-ui"),
        import("@univerjs/docs-ui"),
      ]);
      await import("@univerjs/slides-ui/lib/index.css");
      if (epoch !== renderEpoch) return;
      const el = univerHost.value as HTMLElement;
      const univer = new Univer(await buildUniverLocaleConfig(false, false, true));
      univer.registerPlugin(UniverRenderEnginePlugin);
      univer.registerPlugin(UniverUIPlugin, { container: el });
      univer.registerPlugin(UniverDocsPlugin);
      univer.registerPlugin(UniverDocsUIPlugin);
      univer.registerPlugin(UniverSlidesPlugin);
      univer.registerPlugin(UniverSlidesUIPlugin);
      if (epoch !== renderEpoch) {
        univer.dispose();
        return;
      }
      univer.createUnit(UniverInstanceType.UNIVER_SLIDE, tab.slideData);
      univerInstance = univer;
    } catch (e) {
      console.error("[renderUniver] pptx render ERROR", e);
    }
  }
}

watch(
  activeTab,
  (tab) => {
    if (tab) void renderUniver(tab);
  },
  { immediate: true },
);

async function loadXlsx(tab: ViewerTab): Promise<void> {
  tab.busy = true;
  try {
    const data = await vfs.readBinary(tab.path);
    const { xlsxToUniverWorkbook } = await import("../../lib/univer-xlsx");
    tab.univerData = await xlsxToUniverWorkbook(data);
    if (activeTabId.value === tab.id) await renderUniver(tab);
  } catch (error) {
    tab.error = error instanceof Error ? error.message : String(error);
  } finally {
    tab.busy = false;
  }
}

/** docx → Univer 文档快照（懒加载；转换结果经 UniverDocsCorePreset 渲染）。 */
async function loadDocx(tab: ViewerTab): Promise<void> {
  tab.busy = true;
  try {
    const data = await vfs.readBinary(tab.path);
    const { docxToUniverDocument } = await import("../../lib/univer-docx");
    tab.docData = await docxToUniverDocument(data);
    if (activeTabId.value === tab.id) await renderUniver(tab);
  } catch (error) {
    tab.error = error instanceof Error ? error.message : String(error);
  } finally {
    tab.busy = false;
  }
}

/** pptx → Univer 幻灯片快照（懒加载；转换结果经 Univer Slides 插件渲染）。 */
async function loadPptx(tab: ViewerTab): Promise<void> {
  tab.busy = true;
  try {
    const data = await vfs.readBinary(tab.path);
    const { pptxToUniverSlides } = await import("../../lib/univer-pptx");
    tab.slideData = await pptxToUniverSlides(data);
    if (activeTabId.value === tab.id) await renderUniver(tab);
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
  const proxy = tabs.value[tabs.value.length - 1]; // 取响应式代理：裸对象上的变更不会触发模板更新
  activeTabId.value = path;
  refreshActive();
  if (kind === "xlsx") {
    await loadXlsx(proxy);
  } else if (kind === "docx") {
    await loadDocx(proxy);
  } else if (kind === "pptx") {
    await loadPptx(proxy);
  } else {
    proxy.text = await vfs.readFile(path);
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
  univerInstance?.dispose();
  univerInstance = null;
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
      <div v-if="activeTab.kind === 'html'" class="viewer__frame-wrap">
        <iframe class="viewer__frame" :srcdoc="activeTab.text" :sandbox="sandbox" :title="activeTab.title"></iframe>
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

      <div v-else-if="activeTab.kind === 'xlsx' || activeTab.kind === 'docx' || activeTab.kind === 'pptx'" class="viewer__univer-wrap">
        <div v-once ref="univerHost" class="viewer__univer"></div>
        <p v-if="activeTab.busy" class="footnote viewer__overlay">{{ t("panels.viewer.loading") }}</p>
        <p v-else-if="activeTab.error" class="footnote viewer__overlay">{{ t("panels.viewer.error", { detail: activeTab.error }) }}</p>
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
.viewer__univer-wrap {
  position: relative;
  height: 100%;
  min-height: 360px;
  overflow: hidden;
}
.viewer__univer {
  height: 100%;
}
.viewer__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--panel);
  z-index: 2;
  pointer-events: none;
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
