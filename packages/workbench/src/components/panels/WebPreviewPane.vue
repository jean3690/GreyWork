<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { useChatStore } from "../../stores/chat";
import { useVfsStore } from "../../stores/vfs";
import { appEvents } from "../../events";
import { useI18n } from "vue-i18n";

const chat = useChatStore();
const vfs = useVfsStore();
const { t } = useI18n();

/** 内容源：URL（外部页面）或 HTML（srcdoc 内嵌 AI 产物）。 */
const mode = ref<"url" | "html">("url");
const webUrl = ref("http://localhost:5173/workspace");
const htmlContent = ref("");
const activeHtmlPath = ref("");
/** 沙箱默认禁脚本/禁同源；勾选后仅放行脚本（仍禁同源，隔离可信 iframe）。 */
const allowScripts = ref(false);

const htmlFiles = computed(() => vfs.paths.filter((path) => path.endsWith(".html")).sort());

const sandbox = computed(() => (allowScripts.value ? "allow-scripts" : ""));

async function openHtmlFile(path: string): Promise<void> {
  if (!path) return;
  htmlContent.value = await vfs.readFile(path);
  activeHtmlPath.value = path;
  mode.value = "html";
}

/** 载入内置示例：写入 VFS 并展示，验证「AI 产物 HTML → 内置浏览器渲染」链路。 */
async function loadSample(): Promise<void> {
  const path = "reports/genui/sample.html";
  const sample = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 24px; font-family: ui-sans-serif, system-ui, "Noto Sans SC", sans-serif; background: #fafaf9; color: #292524; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #78716c; font-size: 13px; margin-bottom: 16px; }
  .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
  .kpi { background: #fff; border: 1px solid #e7e5e4; border-radius: 10px; padding: 12px 14px; }
  .kpi b { display: block; font-size: 22px; margin-top: 4px; }
  .kpi span { color: #a8a29e; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e7e5e4; border-radius: 10px; overflow: hidden; font-size: 13px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #f5f5f4; }
  th { background: #1c1917; color: #fff; font-weight: 600; }
  .bar { height: 8px; background: #f59e0b; border-radius: 999px; }
</style>
</head>
<body>
  <h1>站点客流周报</h1>
  <p class="sub">DuckDB 分析 · 由 GreyWork GenUI 生成</p>
  <div class="kpis">
    <div class="kpi"><span>总客流</span><b>12,384</b></div>
    <div class="kpi"><span>峰值日</span><b>周六</b></div>
    <div class="kpi"><span>环比</span><b>+8.2%</b></div>
  </div>
  <table>
    <thead><tr><th>站点</th><th>客流</th><th>占比</th></tr></thead>
    <tbody>
      <tr><td>北京站</td><td>4,281</td><td><div class="bar" style="width:80%"></div></td></tr>
      <tr><td>上海站</td><td>3,650</td><td><div class="bar" style="width:62%"></div></td></tr>
      <tr><td>深圳站</td><td>2,134</td><td><div class="bar" style="width:40%"></div></td></tr>
    </tbody>
  </table>
</body>
</html>`;
  await vfs.write(path, sample);
  await openHtmlFile(path);
}

/* 标注模式：在 iframe 上层叠标记点，投喂给当前对话。 */
const annotateMode = ref(false);
const webMarkers = ref<{ x: number; y: number }[]>([]);

function markSpot(event: MouseEvent): void {
  if (!annotateMode.value) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  webMarkers.value.push({ x: event.clientX - rect.left, y: event.clientY - rect.top });
}

function clearMarkers(): void {
  webMarkers.value = [];
  annotateMode.value = false;
}

function feedScreenshot(): void {
  chat.submitText(t("panels.preview.feedText", { count: webMarkers.value.length }));
  webMarkers.value = [];
}

/* 跨面板联动：GenUI 产物「预览」按钮 → 加载指定 HTML 并切到 HTML 模式。 */
const unsubscribePreview = appEvents.on("preview:request", ({ path }) => void openHtmlFile(path));
onUnmounted(unsubscribePreview);
</script>

<template>
  <div class="side__pane">
    <div class="webprev__bar">
      <div class="webprev__seg" role="group" :aria-label="t('panels.preview.title')">
        <button class="webprev__segbtn" :class="{ active: mode === 'url' }" @click="mode = 'url'">
          {{ t("panels.preview.modeUrl") }}
        </button>
        <button class="webprev__segbtn" :class="{ active: mode === 'html' }" @click="mode = 'html'">
          {{ t("panels.preview.modeHtml") }}
        </button>
      </div>
      <input v-if="mode === 'url'" v-model="webUrl" class="webprev__url" :aria-label="t('panels.preview.modeUrl')" />
      <template v-else>
        <select
          v-model="activeHtmlPath"
          class="webprev__select"
          :aria-label="t('panels.preview.selectHtml')"
          @change="openHtmlFile(activeHtmlPath)"
        >
          <option value="">{{ t("panels.preview.selectHtml") }}</option>
          <option v-for="file in htmlFiles" :key="file" :value="file">{{ file }}</option>
        </select>
        <button class="btn btn--mini" @click="loadSample">{{ t("panels.preview.loadSample") }}</button>
        <label class="webprev__script" :title="t('panels.preview.scriptWarning')">
          <input v-model="allowScripts" type="checkbox" />
          <span>{{ t("panels.preview.allowScripts") }}</span>
        </label>
      </template>
      <button class="btn btn--mini" :class="{ 'btn--on': annotateMode }" @click="annotateMode = !annotateMode">
        {{ annotateMode ? t("panels.preview.annotating") : t("panels.preview.annotateMode") }}
      </button>
      <button class="btn btn--mini" @click="clearMarkers">{{ t("panels.preview.clear") }}</button>
      <button class="btn btn--mini btn--primary" @click="feedScreenshot">{{ t("panels.preview.feed") }}</button>
    </div>
    <div class="webprev" :data-annotate="annotateMode" @click="markSpot">
      <iframe v-if="mode === 'url'" :src="webUrl" :sandbox="sandbox" class="webprev__frame" :title="t('panels.preview.modeUrl')"></iframe>
      <iframe v-else :srcdoc="htmlContent" :sandbox="sandbox" class="webprev__frame" :title="t('panels.preview.modeHtml')"></iframe>
      <span v-for="(mk, i) in webMarkers" :key="i" class="webprev__marker" :style="{ left: mk.x + 'px', top: mk.y + 'px' }">{{
        i + 1
      }}</span>
      <p v-if="mode === 'html' && !htmlContent" class="webprev__empty">{{ t("panels.preview.emptyHtml") }}</p>
    </div>
    <p class="footnote">{{ t("panels.preview.hint", { feed: t("panels.preview.feed") }) }}</p>
  </div>
</template>

<style scoped>
.webprev__seg {
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-2);
}
.webprev__segbtn {
  padding: 3px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dim);
  font-size: 11px;
  transition: 0.15s;
}
.webprev__segbtn.active {
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 600;
}
.webprev__url,
.webprev__select {
  flex: 1;
  min-width: 120px;
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-2);
  color: var(--dim);
  font-size: 10.5px;
}
.webprev__script {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--dim);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}
.webprev__empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--dim2);
  font-size: 12px;
  pointer-events: none;
}
</style>
