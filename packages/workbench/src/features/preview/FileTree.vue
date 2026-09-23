<script setup lang="ts">
/**
 * 右栏「文件」区的树。
 *
 * 渲染用**展平 + 单层 v-for**，不用自引用递归组件：递归组件在深目录下会叠出几十层
 * 组件实例，而展平后只有一个列表，缩进靠 padding。行为完全一样，代价低一个量级。
 */
import { computed, nextTick, onMounted, ref } from "vue";
import { isTauriRuntime, joinPath, normalizePath } from "@greywork/core";
import { useVirtualizer } from "@tanstack/vue-virtual";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import ContextMenuRegion from "@/features/shared/ContextMenuRegion.vue";
import NewEntryDialog from "@/features/preview/NewEntryDialog.vue";
import ConfirmDialog from "@/features/settings/ConfirmDialog.vue";
import { fileIconUrl, folderIconUrl } from "@/lib/file-icons";
import { deviceTier } from "@/lib/device-tier";
import { observeNonZeroRect } from "@/lib/virtual-rect";
import { buildFileTreeItems, type ContextMenuItem, type ContextTarget, type FileEntryRef } from "@/lib/context-menu";
import { nameProblem } from "@/lib/file-name";
import { copyText } from "@/lib/clipboard";
import { openWithSystemApp } from "@/lib/open-external";
import { revealInFolder } from "@/lib/reveal";
import { requestLeave } from "@/lib/preview-edit-guard";
import { i18n } from "@/i18n";
import { notify } from "@/stores/notice";
import { useFileTreeStore, type FileTreeNode } from "@/stores/fileTree";
import { usePreviewStore } from "@/stores/preview";

const tree = useFileTreeStore();
const preview = usePreviewStore();
/** 外壳组件不装 i18n 插件也要能渲染（测试直接 mount 本组件），故用全局实例而非 useI18n。 */
const t = i18n.global.t;

/** 只有桌面端才有磁盘通道；浏览器里绑定路径也读不出树，入口就不该出现。 */
const canBind = isTauriRuntime();
const binding = ref(false);

const rootTitle = computed(() => {
  if (tree.mode !== "disk") return t("preview.fileTree.vfsTitle");
  return tree.bound ? t("preview.fileTree.boundTitle", { path: tree.root }) : t("preview.fileTree.fallbackTitle", { path: tree.root });
});

async function bind(): Promise<void> {
  binding.value = true;
  try {
    await tree.bindFolder();
  } finally {
    binding.value = false;
  }
}

interface FlatRow {
  node: FileTreeNode;
  depth: number;
}

function flatten(nodes: FileTreeNode[], depth: number, out: FlatRow[]): void {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.kind === "directory" && tree.isExpanded(node.path) && node.children) {
      flatten(node.children, depth + 1, out);
    }
  }
}

const rows = computed<FlatRow[]>(() => {
  const out: FlatRow[] = [];
  flatten(tree.nodes, 0, out);
  return out;
});

function activate(node: FileTreeNode): void {
  if (node.kind === "directory") {
    void tree.toggle(node.path);
    return;
  }
  // 树的 mode 决定读取通道：disk 走 Rust fs_read_*，vfs 走内存文件系统。
  preview.open(node.path, node.name, tree.mode === "disk" ? "disk" : "vfs");
}

/* ===== 行虚拟化 =====
 * 展平后的行数 = 展开的目录数 + 文件数，大仓库下轻松上千。整列渲染意味着上千个
 * button + Hint 常驻 DOM，低端机上光是样式计算就够呛。超过阈值切成虚拟窗口：行高恒定
 * （26px、无行间距），只挂载可视窗口 ± overscan。
 * 阈值以下保持整列渲染 —— 短树做虚拟化只是白搭一层绝对定位与测量。
 * 低端设备（lib/device-tier.ts）：阈值减半、overscan 收到 3。 */
const scrollEl = ref<HTMLElement | null>(null);
const VIRTUAL_THRESHOLD = computed(() => (deviceTier.value === "low" ? 30 : 60));
/** 行步长：与 button 的 h-[26px] 一致，树列表无行间距。 */
const ROW_STRIDE = 26;
const virtual = computed(() => rows.value.length > VIRTUAL_THRESHOLD.value);
const virtualOptions = computed(() => {
  // 先读一次 ref 再闭包捕获：`getScrollElement` 内部读不算依赖，模板 ref 赋值就不会让这份
  // options 失效。滚动容器在 loading/错误/空态分支之后，首帧还不存在 —— 不显式建立依赖的话
  // virtualizer 会一直拿着 null，永远算不出可视行。
  const element = scrollEl.value;
  return {
    getScrollElement: () => element,
    // 丢弃 0×0 视口读数：容器刚挂上时还没布局，0 会覆盖 initialRect 让整列算空（见 lib/virtual-rect.ts）。
    observeElementRect: observeNonZeroRect,
    count: virtual.value ? rows.value.length : 0,
    // 首帧视口：RO 就位前先按它渲染窗口，避免空首屏（测试环境无布局时也靠它出内容）。
    initialRect: { top: 0, left: 0, width: 300, height: 600 },
    estimateSize: () => ROW_STRIDE,
    overscan: deviceTier.value === "low" ? 3 : 8,
    getItemKey: (index: number) => rows.value[index]?.node.path ?? index,
  };
});
const virtualizer = useVirtualizer(virtualOptions);

/** 一行在容器里的落位。`row` 直接带上，省得模板里再按下标回查（越界时类型上也拿不到保护）。 */
interface RowSlot {
  index: number;
  key: string;
  start: number;
  row: FlatRow;
}

/**
 * 实际渲染的行。两条路径产出同一种「绝对定位 + translateY」形状，模板只写一遍：
 * - 短树：整列（start = index × 行步长），不做测量；
 * - 长树：虚拟窗口给出的可视行。
 */
const slots = computed<RowSlot[]>(() => {
  if (!virtual.value) {
    return rows.value.map((row, index) => ({ index, key: row.node.path, start: index * ROW_STRIDE, row }));
  }
  return virtualizer.value.getVirtualItems().map((item) => ({
    index: item.index,
    key: String(item.key),
    start: item.start,
    row: rows.value[item.index],
  }));
});

/** 容器总高：两条路径都必须显式给，否则绝对定位的行撑不起滚动条。 */
const totalHeight = computed(() => (virtual.value ? virtualizer.value.getTotalSize() : rows.value.length * ROW_STRIDE));

/* ===== 文件操作（新建 / 重命名 / 复制剪切粘贴 / 删除） =====
 * 宿主的 5 个命令只认授权根内的条目，所以 vfs 模式整组不出现在菜单里（见
 * lib/context-menu.ts 的 canUseDisk 分支）。 */

/** 内联重命名：目标路径 + 草稿名。**放组件级而不是行内 ref** —— 虚拟化会卸载屏外行，
 *  行内状态一滚就没了。 */
const renamingPath = ref<string | null>(null);
const renameDraft = ref("");
/** v-for 里的 ref 会是数组，这里统一收敛成单个 input（同时只有一行在改名）。 */
const renameInputRef = ref<HTMLInputElement | HTMLInputElement[] | null>(null);
/** 新建对话框的目标目录与类型；null = 不显示。 */
const newEntry = ref<{ dir: string; kind: "file" | "directory" } | null>(null);
/** 待确认的删除目标；null = 不显示。 */
const pendingDelete = ref<FileTreeNode | null>(null);

/** 统一的文件操作包装：失败弹通知，不让异常冒到事件处理器外面。 */
async function runFileOp(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (cause) {
    notify({
      kind: "warning",
      key: "file-tree-op",
      title: t("fileOp.opFailed"),
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function startRename(node: FileTreeNode): void {
  renamingPath.value = node.path;
  renameDraft.value = node.name;
  void nextTick(() => {
    const input = Array.isArray(renameInputRef.value) ? renameInputRef.value[0] : renameInputRef.value;
    input?.focus();
    input?.select();
  });
}

function cancelRename(): void {
  renamingPath.value = null;
  renameDraft.value = "";
}

/** 提交改名；名字没变或非法就当作取消（非法名给一条提示，不然用户不知道为什么不生效）。 */
async function commitRename(node: FileTreeNode): Promise<void> {
  if (renamingPath.value !== node.path) return;
  const name = renameDraft.value.trim();
  renamingPath.value = null;
  if (!name || name === node.name) return;
  if (nameProblem(name)) {
    notify({ kind: "warning", key: "file-tree-rename", title: t("preview.fileTree.nameProblem.invalid"), detail: name });
    return;
  }
  await runFileOp(() => tree.renameEntry(node.path, name));
}

/** 删除入口：先过守卫（这个文件可能正开着且有未保存改动），存完再删。 */
function confirmDelete(): void {
  const node = pendingDelete.value;
  pendingDelete.value = null;
  if (!node) return;
  requestLeave(() => void runFileOp(() => tree.deleteEntry(node.path)));
}

/* ===== 键盘导航 =====
 * 行本来就是 `<button>`，键盘焦点天然落在某一行上；这里只补浏览器没给的那些：
 * 方向键在行之间移动焦点、右 / 左进出一层、Home/End 跳到首尾、F2 改名、Delete 删除、
 * Ctrl+C/X/V 走应用内剪贴板。
 *
 * **Enter / Space 刻意不接**：button 原生就会把它们变成 click（= activate），自己再处理
 * 一遍就成了「展开又立刻收起」。所以这里也不 preventDefault，让原生行为照常发生。
 */
/** 最后一次落到的那一行（点击 / 聚焦 / 方向键都会更新），供 rowIndexAt 兜底。 */
const anchorPath = ref<string | null>(null);

/** 当前按键落在第几行（-1 = 焦点不在任何行上，例如还在容器里）。 */
function rowIndexAt(event: KeyboardEvent): number {
  const host = (event.target as HTMLElement | null)?.closest?.("[data-index]");
  const raw = host?.getAttribute("data-index");
  if (raw !== null && raw !== undefined) return Number(raw);
  // 焦点不在某一行上（例如落在容器、或整行被改名输入框替掉）时，用最后一次落到的那行兜底。
  const anchor = anchorPath.value;
  if (anchor === null) return -1;
  return rows.value.findIndex((row) => row.node.path === anchor);
}

function ensureRowVisible(index: number): void {
  if (virtual.value) {
    virtualizer.value.scrollToIndex(index, { align: "auto" });
    return;
  }
  const el = scrollEl.value;
  // 无布局环境（测试）里 clientHeight 为 0：算不出可视窗口，别把滚动位置搅乱。
  if (!el || el.clientHeight === 0) return;
  const top = index * ROW_STRIDE;
  const bottom = top + ROW_STRIDE;
  if (top < el.scrollTop) el.scrollTop = top;
  else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
}

/** 把焦点挪到第 index 行；目标行可能在虚拟窗口之外，先滚过去再聚焦。 */
async function focusRowAt(index: number): Promise<void> {
  const list = rows.value;
  if (list.length === 0) return;
  const clamped = Math.max(0, Math.min(list.length - 1, index));
  anchorPath.value = list[clamped].node.path;
  ensureRowVisible(clamped);
  await nextTick();
  scrollEl.value?.querySelector<HTMLElement>(`[data-index="${clamped}"] [data-testid="file-tree-row"]`)?.focus();
}

/** 点行：先记下焦点行再激活，这样接着按方向键从这一行继续。 */
function onRowClick(node: FileTreeNode): void {
  anchorPath.value = node.path;
  activate(node);
}

/** 右方向键：折叠态目录先展开；已展开则进入第一个子项。 */
async function stepInto(index: number): Promise<void> {
  const row = rows.value[index];
  if (!row) return;
  if (row.node.kind === "directory" && !tree.isExpanded(row.node.path)) {
    await tree.toggle(row.node.path);
    return;
  }
  const next = rows.value[index + 1];
  if (next && next.depth > row.depth) await focusRowAt(index + 1);
}

/** 左方向键：展开态目录先收起；否则跳到父行（上一个更浅的行）。 */
async function stepOut(index: number): Promise<void> {
  const row = rows.value[index];
  if (!row) return;
  if (row.node.kind === "directory" && tree.isExpanded(row.node.path)) {
    await tree.toggle(row.node.path);
    return;
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    if (rows.value[i].depth < row.depth) {
      await focusRowAt(i);
      return;
    }
  }
}

function entryOf(node: FileTreeNode): FileEntryRef {
  return { path: node.path, name: node.name, kind: node.kind };
}

function onTreeKeydown(event: KeyboardEvent): void {
  // 改名输入框里的按键归它自己（含文本选择与粘贴）。
  if ((event.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable]")) return;

  const list = rows.value;
  const index = rowIndexAt(event);
  const node = index >= 0 ? list[index]?.node : undefined;
  const disk = tree.mode === "disk";

  if (event.ctrlKey || event.metaKey) {
    const key = event.key.toLowerCase();
    if (key === "c" && node && disk) tree.copyToClipboard(entryOf(node));
    else if (key === "x" && node && disk) tree.cutToClipboard(entryOf(node));
    else if (key === "v" && disk) void runFileOp(() => tree.pasteInto(dropDirOf(node ?? null)));
    else return;
    event.preventDefault();
    return;
  }

  switch (event.key) {
    case "ArrowDown":
      void focusRowAt(index < 0 ? 0 : index + 1);
      break;
    case "ArrowUp":
      void focusRowAt(index < 0 ? list.length - 1 : index - 1);
      break;
    case "ArrowRight":
      if (index < 0) return;
      void stepInto(index);
      break;
    case "ArrowLeft":
      if (index < 0) return;
      void stepOut(index);
      break;
    case "Home":
      void focusRowAt(0);
      break;
    case "End":
      void focusRowAt(list.length - 1);
      break;
    case "F2":
      if (!node || !disk) return;
      startRename(node);
      break;
    case "Delete":
      if (!node || !disk) return;
      pendingDelete.value = node;
      break;
    default:
      return;
  }
  event.preventDefault();
}

/* ===== 拖拽移动 =====
 * 落点目录：目录行 = 它自己，文件行 = 它所在的目录（拖到文件上等价于拖到那个目录）。
 * 树根不在 rows 里，所以空白区单独接一层（拖进根目录）。 */
const dragSource = ref<FileTreeNode | null>(null);
const dropTarget = ref<string | null>(null);

function dropDirOf(node: FileTreeNode | null): string {
  if (!node) return tree.root;
  return node.kind === "directory" ? node.path : tree.parentOf(node.path);
}

/** 拖进自己的子树会把目录搬丢；同目录内移动没有意义（宿主会报「目标已存在」）。 */
function canDropInto(source: FileTreeNode, targetDir: string): boolean {
  if (tree.mode !== "disk") return false;
  const from = normalizePath(source.path);
  const to = normalizePath(targetDir);
  if (to === from || to.startsWith(`${from}/`)) return false;
  return normalizePath(tree.parentOf(source.path)) !== to;
}

function onRowDragStart(event: DragEvent, node: FileTreeNode): void {
  if (tree.mode !== "disk") return;
  dragSource.value = node;
  // 有的浏览器要求 dragstart 里写点数据才肯启动拖拽。
  event.dataTransfer?.setData("text/plain", node.path);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onRowDragOver(event: DragEvent, node: FileTreeNode): void {
  const source = dragSource.value;
  if (!source) return;
  const dir = dropDirOf(node);
  if (!canDropInto(source, dir)) return;
  // 只有 preventDefault 之后才允许放置；不设 dropTarget 就不会亮。
  event.preventDefault();
  dropTarget.value = dir;
}

function onRowDrop(event: DragEvent, node: FileTreeNode): void {
  const source = dragSource.value;
  const dir = dropDirOf(node);
  endDrag();
  if (!source || !canDropInto(source, dir)) return;
  event.preventDefault();
  void runFileOp(() => tree.moveEntry(source.path, joinPath(dir, source.name)));
}

/** 空白区 = 树的根目录：允许把条目拖到根下。 */
function onBlankDragOver(event: DragEvent): void {
  const source = dragSource.value;
  if (!source || !canDropInto(source, tree.root)) return;
  event.preventDefault();
  dropTarget.value = tree.root;
}

function onBlankDrop(event: DragEvent): void {
  const source = dragSource.value;
  endDrag();
  if (!source || !canDropInto(source, tree.root)) return;
  event.preventDefault();
  void runFileOp(() => tree.moveEntry(source.path, joinPath(tree.root, source.name)));
}

function endDrag(): void {
  dragSource.value = null;
  dropTarget.value = null;
}

/* ===== 右键菜单 =====
 * 整棵树只挂一个 reka root，靠 data-ctx 认目标；逐行挂 root 会在深目录下叠出成百个
 * 组件实例。虚拟化后行会随滚动进出 DOM，菜单仍按 data-path 回查 rows，与挂载无关。
 * 条目构建在 lib/context-menu（可单测）。 */
function nodeOf(path: string): FileTreeNode | undefined {
  return rows.value.find((row) => row.node.path === path)?.node;
}

function buildMenu(target: ContextTarget | null): ContextMenuItem[] {
  // 菜单只给路径，按路径回查节点补出 name / kind（与 activateByPath 同一手法）。
  return buildFileTreeItems(target, t, {
    activate: activateByPath,
    refresh: () => void tree.refresh(),
    // 只有磁盘源才有磁盘孪生路径；vfs 产物不给「系统应用打开 / 在文件夹中显示」，也不能增删改。
    canUseDisk: tree.mode === "disk",
    rootPath: tree.root,
    openExternal: (path) => void openExternal(path),
    reveal: (path) => void reveal(path),
    copyPath: (path) => void copyText(path),
    createFile: (dir) => (newEntry.value = { dir, kind: "file" }),
    createFolder: (dir) => (newEntry.value = { dir, kind: "directory" }),
    rename: (path) => {
      const node = nodeOf(path);
      if (node) startRename(node);
    },
    remove: (path) => {
      const node = nodeOf(path);
      if (node) pendingDelete.value = node;
    },
    copy: (entry: FileEntryRef) => tree.copyToClipboard(entry),
    cut: (entry: FileEntryRef) => tree.cutToClipboard(entry),
    paste: (dir) => void runFileOp(() => tree.pasteInto(dir)),
    canPaste: tree.clipboard !== null,
  });
}

/** 菜单里只有路径，按路径回查节点补出 name（activate 需要）。 */
function activateByPath(path: string, kind: "file" | "directory"): void {
  if (kind === "directory") {
    void tree.toggle(path);
    return;
  }
  const node = rows.value.find((row) => row.node.path === path)?.node;
  if (node) activate(node);
}

async function openExternal(path: string): Promise<void> {
  if (await openWithSystemApp(path)) return;
  notify({
    kind: "warning",
    key: "file-tree-open-external",
    title: t("fileOp.openFailed"),
    detail: t("fileOp.openFailedDetail", { path }),
  });
}

async function reveal(path: string): Promise<void> {
  if (await revealInFolder(path)) return;
  notify({
    kind: "warning",
    key: "file-tree-reveal",
    title: t("fileOp.revealFailed"),
    detail: t("fileOp.revealFailedDetail", { path }),
  });
}

onMounted(() => {
  void tree.refresh();
});
</script>

<template>
  <ContextMenuRegion :build="buildMenu">
    <div class="flex size-full min-h-0 flex-col overflow-hidden" data-testid="file-tree">
      <!-- 根目录提示条：让人知道这棵树是谁。vfs 模式说明为什么看到的是产物而不是磁盘 -->
      <div class="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-1.5">
        <Hint :text="rootTitle" multiline>
          <span class="min-w-0 flex-1 truncate font-mono text-[10.5px] text-dim2">
            {{ tree.mode === "disk" ? tree.root : t("preview.fileTree.vfsLabel") }}
          </span>
        </Hint>
        <Hint v-if="canBind" :text="tree.bound ? t('preview.fileTree.rebindHint') : t('preview.fileTree.bindHint')" multiline>
          <button
            type="button"
            data-testid="file-tree-bind"
            class="h-5 shrink-0 cursor-pointer rounded-[5px] px-1.5 text-[10.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
            :class="tree.bound ? 'text-dim2 hover:bg-panel hover:text-foreground' : 'bg-cyan/15 text-cyan hover:bg-cyan/25'"
            :disabled="binding"
            @click="bind()"
          >
            {{ binding ? t("preview.fileTree.binding") : tree.bound ? t("preview.fileTree.rebind") : t("preview.fileTree.bind") }}
          </button>
        </Hint>
        <button
          type="button"
          data-testid="file-tree-refresh"
          class="grid size-[24px] shrink-0 cursor-pointer place-items-center rounded-[5px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          :aria-label="t('contextMenu.fileTree.refresh')"
          @click="tree.refresh()"
        >
          <Icon name="refresh" :size="12" />
        </button>
      </div>

      <!-- 未绑定时说清「这不是你的项目目录」：否则一棵 home 目录树看起来就像 bug -->
      <p v-if="canBind && tree.mode === 'disk' && !tree.bound" class="shrink-0 px-3 py-1.5 text-[10.5px] text-dim2">
        {{ t("preview.fileTree.unboundNotice") }}
      </p>

      <p v-if="tree.loadingRoot" class="px-3 py-2 text-[12px] text-dim2">{{ t("preview.fileTree.loading") }}</p>
      <p v-else-if="tree.error" role="alert" class="px-3 py-2 text-[12px] text-orange">{{ tree.error }}</p>
      <p v-else-if="rows.length === 0" class="px-3 py-2 text-[12px] text-dim2">{{ t("preview.fileTree.empty") }}</p>

      <div
        v-else
        ref="scrollEl"
        class="min-h-0 flex-1 overflow-auto py-1"
        data-testid="file-tree-scroll"
        @keydown="onTreeKeydown"
        @dragover="onBlankDragOver"
        @drop="onBlankDrop"
      >
        <!-- 相对容器 + 显式总高：行一律绝对定位在 translateY 处，虚拟与非虚拟共用一套模板 -->
        <div class="relative" :class="dropTarget === tree.root ? 'bg-cyan/5' : ''" :style="{ height: `${totalHeight}px` }">
          <div
            v-for="slot in slots"
            :key="slot.key"
            :data-index="slot.index"
            class="absolute left-0 top-0 w-full"
            :class="dropTarget !== null && dropTarget === dropDirOf(slot.row.node) ? 'bg-cyan/10' : ''"
            :style="{ transform: `translateY(${slot.start}px)` }"
            data-ctx="file-row"
            :data-path="slot.row.node.path"
            :data-kind="slot.row.node.kind"
            @dragover.stop="onRowDragOver($event, slot.row.node)"
            @drop.stop="onRowDrop($event, slot.row.node)"
          >
            <!-- 改名时整行换成 input：**不能把 input 塞进 button**（HTML 内容模型非法），
                 所以两个分支是平级的整行二选一。data-ctx 也因此上移到这一层 ——
                 `closest("[data-ctx]")` 在改名期间仍要命中这一行。 -->
            <input
              v-if="renamingPath === slot.row.node.path"
              ref="renameInputRef"
              v-model="renameDraft"
              type="text"
              data-testid="file-tree-rename"
              class="h-[26px] w-full rounded-[4px] border border-cyan bg-panel-2 pe-2 text-[12px] text-foreground outline-none"
              :style="{ paddingInlineStart: `${8 + slot.row.depth * 12}px` }"
              @keydown.enter.prevent="commitRename(slot.row.node)"
              @keydown.esc.prevent="cancelRename()"
              @blur="commitRename(slot.row.node)"
            />
            <Hint v-else :text="slot.row.node.path" multiline>
              <button
                type="button"
                data-testid="file-tree-row"
                class="flex h-[26px] w-full cursor-pointer items-center gap-1 pe-2 text-start text-[12px] transition-colors hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
                :class="slot.row.node.kind === 'directory' ? 'text-foreground' : 'text-dim hover:text-foreground'"
                :style="{ paddingInlineStart: `${8 + slot.row.depth * 12}px` }"
                :aria-expanded="slot.row.node.kind === 'directory' ? tree.isExpanded(slot.row.node.path) : undefined"
                :draggable="tree.mode === 'disk'"
                @click="onRowClick(slot.row.node)"
                @focus="anchorPath = slot.row.node.path"
                @dragstart="onRowDragStart($event, slot.row.node)"
                @dragend="endDrag()"
              >
                <span class="grid size-3.5 shrink-0 place-items-center text-dim2">
                  <Icon
                    v-if="slot.row.node.kind === 'directory'"
                    :name="tree.isLoading(slot.row.node.path) ? 'refresh' : tree.isExpanded(slot.row.node.path) ? 'down' : 'right'"
                    :size="11"
                  />
                </span>
                <template v-if="slot.row.node.kind === 'directory'">
                  <img
                    :src="folderIconUrl(slot.row.node.name, tree.isExpanded(slot.row.node.path))"
                    alt=""
                    aria-hidden="true"
                    class="size-3.5 shrink-0 object-contain"
                    :class="{ 'animate-spin opacity-60': tree.isLoading(slot.row.node.path) }"
                    loading="lazy"
                    decoding="async"
                    draggable="false"
                  />
                </template>
                <img
                  v-else
                  :src="fileIconUrl(slot.row.node.name)"
                  alt=""
                  aria-hidden="true"
                  class="size-3.5 shrink-0 object-contain"
                  loading="lazy"
                  decoding="async"
                  draggable="false"
                />
                <span class="min-w-0 flex-1 truncate">{{ slot.row.node.name }}</span>
              </button>
            </Hint>
          </div>
        </div>
      </div>
    </div>
  </ContextMenuRegion>

  <!-- 两个弹层挂在 ContextMenuRegion **之外**：region 的 trigger 是 `as-child`，
       塞多一个根节点进去会让它拿不到唯一的子元素（见 lib/context-menu.ts 顶部约定）。 -->
  <NewEntryDialog v-if="newEntry" :dir="newEntry.dir" :kind="newEntry.kind" @close="newEntry = null" />
  <ConfirmDialog
    v-if="pendingDelete"
    :title="t('preview.fileTree.deleteTitle', { name: pendingDelete.name })"
    :message="t('preview.fileTree.deleteMessage')"
    :confirm-label="t('common.delete')"
    @confirm="confirmDelete"
    @cancel="pendingDelete = null"
  />
</template>
