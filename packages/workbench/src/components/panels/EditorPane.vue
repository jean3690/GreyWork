<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from "vue";
/* 异步分包：CodeMirror 及语言包独立 chunk，不进主包 */
const CodeMirrorPane = defineAsyncComponent(() => import("../CodeMirrorPane.vue"));
import MarkdownText from "../MarkdownText.vue";
import { ArrowLeft, ChevronDown, ChevronRight, FileSpreadsheet, FileText, Folder, Plus, Save, X } from "lucide-vue-next";
import { buildFileTree, statusLetter, useVfsStore, type VfsTreeNode } from "../../stores/vfs";
import { useI18n } from "vue-i18n";

const vfs = useVfsStore();
const { t } = useI18n();
/** 列表态 ↔ 文件态（OS 式进入：点文件才展示内容，返回键回列表）。 */
const view = ref<"list" | "file">("list");
const mode = ref<"edit" | "preview">("edit");

/** 目录展开状态（默认全部展开；小工作区 OS 习惯）。 */
const expanded = ref(new Set<string>());
const tree = computed(() => {
  const walk = (nodes: VfsTreeNode[], depth: number): Array<{ node: VfsTreeNode; depth: number }> =>
    nodes.flatMap((node) =>
      node.kind === "directory" && expanded.value.has(node.path)
        ? [{ node, depth }, ...walk(node.children ?? [], depth + 1)]
        : [{ node, depth }],
    );
  return walk(buildFileTree(vfs.paths), 0);
});

function toggleDir(path: string): void {
  const next = new Set(expanded.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  expanded.value = next;
}

onMounted(() => {
  const dirs = new Set<string>();
  for (const path of vfs.paths) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) dirs.add(parts.slice(0, depth).join("/"));
  }
  expanded.value = dirs;
});

/** 新建文件：行内输入，Enter 确认。 */
const creating = ref(false);
const newPath = ref("");
const newFileInput = ref<HTMLInputElement | null>(null);
async function startCreate(): Promise<void> {
  creating.value = true;
  newPath.value = "";
  await new Promise((resolve) => setTimeout(resolve, 30));
  newFileInput.value?.focus();
}
async function confirmCreate(): Promise<void> {
  const path = newPath.value.trim().replace(/^\/+|\/+$/g, "");
  if (!path || vfs.paths.includes(path)) {
    creating.value = false;
    return;
  }
  await vfs.write(path, "");
  await vfs.open(path);
  mode.value = "edit";
  view.value = "file";
  creating.value = false;
  for (let depth = 1; depth < path.split("/").length; depth += 1) expanded.value.add(path.split("/").slice(0, depth).join("/"));
}

/** 删除：两段确认（× → ✓），2.5s 未确认自动还原。 */
const deletingPath = ref("");
let deleteTimer: ReturnType<typeof setTimeout> | null = null;
function requestDelete(path: string): void {
  if (deletingPath.value === path) {
    void (async () => {
      await vfs.remove(path);
      if (vfs.activePath === path) {
        const fallback = vfs.paths[0];
        if (fallback) await vfs.open(fallback);
      }
    })();
    deletingPath.value = "";
    return;
  }
  deletingPath.value = path;
  if (deleteTimer) clearTimeout(deleteTimer);
  deleteTimer = setTimeout(() => (deletingPath.value = ""), 2500);
}

const ext = computed(() => vfs.activePath.split(".").pop() ?? "");
const LANG: Record<string, string> = { ts: "typescript", vue: "html", md: "markdown", csv: "plaintext", json: "json" };
const language = computed(() => LANG[ext.value] ?? "plaintext");

const activeLetter = computed(() => {
  const change = vfs.changes.find((entry) => entry.path === vfs.activePath);
  return change ? statusLetter(change.status) : "";
});

async function openFile(path: string): Promise<void> {
  // 二进制产物（xlsx 等）：不读文本，进入只读占位预览
  if (path.endsWith(".xlsx")) {
    const data = await vfs.readBinary(path);
    binaryInfo.value = { path, bytes: data.byteLength };
    view.value = "file";
    mode.value = "preview";
    return;
  }
  binaryInfo.value = null;
  await vfs.open(path);
  mode.value = "edit";
  view.value = "file";
}
/** 二进制文件占位信息（打开 .xlsx 等产物时展示，不做文本编辑）。 */
const binaryInfo = ref<{ path: string; bytes: number } | null>(null);
async function save(): Promise<void> {
  await vfs.saveActive();
}

/** 面包屑点目录：回列表态并展开到该层。 */
function revealDir(dir: string): void {
  const parts = dir.split("/");
  for (let depth = 1; depth <= parts.length; depth += 1) expanded.value.add(parts.slice(0, depth).join("/"));
  view.value = "list";
}
</script>

<template>
  <div class="side__pane editor-pane">
    <!-- 文件态：返回 + 路径 + 模式 + 保存 -->
    <template v-if="view === 'file'">
      <div class="editor-pane__bar">
        <button class="editor-pane__back" :title="t('panels.editor.back')" :aria-label="t('panels.editor.back')" @click="view = 'list'">
          <ArrowLeft class="size-4" />
        </button>
        <div class="editor-pane__seg" role="group" :aria-label="t('panels.editor.viewMode')">
          <button class="editor-pane__segbtn" :class="{ active: mode === 'edit' }" @click="mode = 'edit'">
            {{ t("panels.editor.edit") }}
          </button>
          <button class="editor-pane__segbtn" :class="{ active: mode === 'preview' }" @click="mode = 'preview'">
            {{ t("panels.preview.title") }}
          </button>
        </div>
        <button class="btn btn--primary btn--mini" :disabled="!vfs.dirty" :title="t('panels.editor.writeVfs')" @click="save">
          <Save class="size-3.5" />{{ t("panels.editor.save") }}
        </button>
      </div>
      <nav class="editor-pane__crumbs" :aria-label="t('panels.editor.filePath')" :title="vfs.activePath">
        <template v-for="(segment, index) in vfs.activePath.split('/')" :key="index">
          <span v-if="index > 0" class="editor-pane__crumbsep">›</span>
          <button
            v-if="index < vfs.activePath.split('/').length - 1"
            class="editor-pane__crumb"
            :title="
              t('panels.editor.viewInList', {
                path: vfs.activePath
                  .split('/')
                  .slice(0, index + 1)
                  .join('/'),
              })
            "
            @click="
              revealDir(
                vfs.activePath
                  .split('/')
                  .slice(0, index + 1)
                  .join('/'),
              )
            "
          >
            {{ segment }}
          </button>
          <span v-else class="editor-pane__crumbfile">{{ segment }}</span>
        </template>
      </nav>
      <p class="editor-pane__meta">
        {{ language }} · UTF-8 · LF
        <span v-if="vfs.dirty" class="editor-pane__dirty">{{ t("panels.editor.unsaved") }}</span>
        <span v-if="activeLetter" class="tree-row__status" :data-status="activeLetter">{{ activeLetter }}</span>
      </p>

      <CodeMirrorPane v-if="mode === 'edit'" v-model:value="vfs.activeContent" :language="language" class="editor-pane__editor" />
      <div v-else-if="ext === 'md'" class="editor-pane__preview">
        <MarkdownText :content="vfs.activeContent" />
      </div>
      <div v-else-if="ext === 'csv'" class="editor-pane__preview editor-pane__table">
        <table>
          <thead>
            <tr>
              <th v-for="head in vfs.activeContent.trimEnd().split('\n')[0]?.split(',') ?? []" :key="head">{{ head }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in vfs.activeContent
                .trimEnd()
                .split('\n')
                .slice(1)
                .map((line) => line.split(','))"
              :key="row[0]"
            >
              <td v-for="cell in row" :key="cell">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <pre v-else-if="!binaryInfo" class="editor-pane__preview editor-pane__raw">{{ vfs.activeContent }}</pre>
      <div v-else class="editor-pane__preview xlsx-note">
        <FileSpreadsheet class="size-4" />
        <span>{{ binaryInfo.path }} · {{ binaryInfo.bytes.toLocaleString() }} bytes · {{ t("panels.editor.xlsxNote") }}</span>
      </div>
    </template>

    <!-- 列表态：OS 式文件列表占满 -->
    <template v-else>
      <div class="editor-pane__bar">
        <span class="editor-pane__cap">{{ t("panels.file") }} · {{ vfs.paths.length }}</span>
        <button class="editor-pane__new" :title="t('panels.editor.newFileHint')" @click="startCreate">
          <Plus class="size-3.5" />{{ t("panels.editor.newFile") }}
        </button>
      </div>

      <div class="editor-pane__tree" data-testid="vfs-file-tree">
        <template v-for="{ node, depth } in tree" :key="node.kind + node.path">
          <button
            v-if="node.kind === 'directory'"
            class="tree-row tree-row--dir"
            :style="{ paddingLeft: `${8 + depth * 13}px` }"
            :title="node.path"
            :aria-expanded="expanded.has(node.path)"
            @click="toggleDir(node.path)"
          >
            <component :is="expanded.has(node.path) ? ChevronDown : ChevronRight" class="size-3" />
            <Folder class="size-3.5" />
            <span class="tree-row__name">{{ node.name }}/</span>
          </button>
          <div
            v-else
            class="tree-row tree-row--file"
            :class="{ active: vfs.activePath === node.path }"
            :style="{ paddingLeft: `${25 + depth * 13}px` }"
          >
            <button class="tree-row__open" :title="node.path" @click="openFile(node.path)">
              <FileText class="size-3.5" />
              <span class="tree-row__name">{{ node.name }}</span>
            </button>
            <span v-if="activeLetter && vfs.activePath === node.path" class="tree-row__status" :data-status="activeLetter">{{
              activeLetter
            }}</span>
            <button
              class="tree-row__del"
              :class="{ confirm: deletingPath === node.path }"
              :title="deletingPath === node.path ? t('panels.editor.confirmDelete') : t('panels.editor.deleteFile')"
              :aria-label="t('panels.editor.deletePath', { path: node.path })"
              @click.stop="requestDelete(node.path)"
            >
              <X v-if="deletingPath !== node.path" class="size-3" />
              <span v-else class="tree-row__deltext">✓</span>
            </button>
          </div>
        </template>
        <div v-if="creating" class="tree-row tree-row--creating">
          <FileText class="size-3.5" />
          <input
            ref="newFileInput"
            v-model="newPath"
            class="tree-row__newinput"
            :placeholder="t('panels.editor.pathPlaceholder')"
            :aria-label="t('panels.editor.newPathAria')"
            @keydown.enter="confirmCreate"
            @keydown.esc="creating = false"
            @blur="confirmCreate"
          />
        </div>
        <p v-if="!vfs.paths.length && !creating" class="footnote">{{ t("panels.editor.emptyHint") }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.editor-pane {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
.editor-pane__bar {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.editor-pane__bar .btn--mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  padding: 6px 8px;
}
.editor-pane__back {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border: 1px solid var(--line-2);
  border-radius: 8px;
  background: transparent;
  color: var(--dim);
  transition: 0.15s;
}
.editor-pane__back:hover {
  background: var(--panel-2);
  color: var(--text);
}
.editor-pane__crumbs {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  justify-content: flex-end;
  gap: 3px;
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: nowrap;
}
.editor-pane__crumb:first-child {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}
.editor-pane__crumb {
  flex: 0 0 auto;
  padding: 2px 3px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--dim);
  font-size: inherit;
  transition: 0.12s;
}
.editor-pane__crumb:hover {
  background: var(--panel-2);
  color: var(--text);
}
.editor-pane__crumbfile {
  flex: 0 0 auto;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
  font-weight: 600;
}
.editor-pane__seg {
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
  padding: 2px;
  margin-left: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-2);
}
.editor-pane__segbtn {
  padding: 4px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dim);
  font-size: 11px;
  transition: 0.15s;
}
.editor-pane__segbtn.active {
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 600;
}
.editor-pane__new {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 5px 8px;
  border: 1px solid var(--line-2);
  border-radius: 8px;
  background: transparent;
  color: var(--dim);
  font-size: 11px;
  white-space: nowrap;
  transition: 0.15s;
}
.editor-pane__new:hover {
  background: var(--panel-2);
  color: var(--text);
}

.editor-pane__tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-2);
  scrollbar-width: thin;
  scrollbar-color: var(--line-2) transparent;
}
.tree-row {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 4px 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--dim);
  font-size: 11.5px;
  text-align: left;
  transition: 0.12s;
}
.tree-row--dir {
  cursor: pointer;
  font-weight: 600;
}
.tree-row--dir:hover {
  background: var(--panel);
  color: var(--text);
}
.tree-row--file {
  padding-right: 4px;
}
.tree-row--file:hover {
  background: var(--panel);
}
.tree-row--file.active {
  background: var(--panel);
  color: var(--text);
  box-shadow: inset 2px 0 0 var(--accent);
}
.tree-row__open {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font-size: inherit;
  text-align: left;
  cursor: pointer;
}
.tree-row__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tree-row__status {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: 15px;
  height: 15px;
  border-radius: 4px;
  background: var(--panel);
  color: var(--amber);
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 700;
}
.tree-row__status[data-status="U"] {
  color: var(--mint);
}
.tree-row__del {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--dim2);
  opacity: 0;
  transition: 0.12s;
}
.tree-row--file:hover .tree-row__del,
.tree-row__del.confirm {
  opacity: 1;
}
.tree-row__del:hover {
  background: var(--panel);
  color: var(--aion-red);
}
.tree-row__del.confirm {
  background: var(--aion-red);
  color: #ffffff;
}
.tree-row__deltext {
  font-size: 10px;
  font-weight: 700;
}
.tree-row--creating {
  gap: 6px;
  color: var(--dim);
}
.tree-row__newinput {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 11px;
}

.editor-pane__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  overflow: hidden;
  color: var(--dim2);
  font-family: var(--font-mono);
  font-size: 10px;
}
.editor-pane__editor {
  flex: 1;
  min-height: 0;
}

.editor-pane__editor:deep(.cm-pane) {
  height: 100%;
  min-height: 0;
}

.editor-pane__preview {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--line-2);
  border-radius: 12px;
  background: var(--panel);
  font-size: 12px;
}
.editor-pane__table table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-size: 10.5px;
}
.editor-pane__table th,
.editor-pane__table td {
  padding: 5px 7px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  color: var(--dim);
}
.editor-pane__table th {
  color: var(--text);
  font-weight: 600;
}
.editor-pane__raw {
  margin: 0;
  color: var(--dim);
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: pre-wrap;
}
.xlsx-note {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--dim);
  font-size: 12px;
}
</style>
