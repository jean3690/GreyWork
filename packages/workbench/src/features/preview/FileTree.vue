<script setup lang="ts">
/**
 * 右栏「文件」区的树。
 *
 * 渲染用**展平 + 单层 v-for**，不用自引用递归组件：递归组件在深目录下会叠出几十层
 * 组件实例，而展平后只有一个列表，缩进靠 padding。行为完全一样，代价低一个量级。
 */
import { computed, onMounted, ref } from "vue";
import { isTauriRuntime } from "@greywork/core";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import ContextMenuRegion from "@/features/shared/ContextMenuRegion.vue";
import { fileIconUrl, folderIconUrl } from "@/lib/file-icons";
import { buildFileTreeItems, type ContextMenuItem, type ContextTarget } from "@/lib/context-menu";
import { copyText } from "@/lib/clipboard";
import { openWithSystemApp } from "@/lib/open-external";
import { revealInFolder } from "@/lib/reveal";
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
  if (tree.mode !== "disk") return "内存虚拟文件系统";
  return tree.bound ? `已绑定：${tree.root}` : `未绑定文件夹，兜底目录：${tree.root}`;
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

/* ===== 右键菜单 =====
 * 行不虚拟化（展平单层 v-for），所以整棵树只挂一个 reka root，靠 data-ctx 认目标；
 * 逐行挂 root 会在深目录下叠出成百个组件实例。条目构建在 lib/context-menu（可单测）。 */
function buildMenu(target: ContextTarget | null): ContextMenuItem[] {
  return buildFileTreeItems(target, t, {
    activate: activateByPath,
    refresh: () => void tree.refresh(),
    // 只有磁盘源才有磁盘孪生路径；vfs 产物不给「系统应用打开 / 在文件夹中显示」。
    canUseDisk: tree.mode === "disk",
    openExternal: (path) => void openExternal(path),
    reveal: (path) => void reveal(path),
    copyPath: (path) => void copyText(path),
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
            {{ tree.mode === "disk" ? tree.root : "内存文件系统（产物与种子文件）" }}
          </span>
        </Hint>
        <Hint
          v-if="canBind"
          :text="tree.bound ? '换绑工作区文件夹：既有会话文件一并搬到新目录' : '绑定工作区文件夹：文件树与产物都以该文件夹为根'"
          multiline
        >
          <button
            type="button"
            data-testid="file-tree-bind"
            class="h-5 shrink-0 cursor-pointer rounded-[5px] px-1.5 text-[10.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
            :class="tree.bound ? 'text-dim2 hover:bg-panel hover:text-foreground' : 'bg-cyan/15 text-cyan hover:bg-cyan/25'"
            :disabled="binding"
            @click="bind()"
          >
            {{ binding ? "选择中…" : tree.bound ? "换绑" : "绑定文件夹" }}
          </button>
        </Hint>
        <button
          type="button"
          data-testid="file-tree-refresh"
          class="grid size-[24px] shrink-0 cursor-pointer place-items-center rounded-[5px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          aria-label="刷新文件树"
          @click="tree.refresh()"
        >
          <Icon name="refresh" :size="12" />
        </button>
      </div>

      <!-- 未绑定时说清「这不是你的项目目录」：否则一棵 home 目录树看起来就像 bug -->
      <p v-if="canBind && tree.mode === 'disk' && !tree.bound" class="shrink-0 px-3 py-1.5 text-[10.5px] text-dim2">
        当前工作区未绑定文件夹，显示的是兜底目录。绑定后文件树、产物落盘与 agent 读写都以该文件夹为根。
      </p>

      <p v-if="tree.loadingRoot" class="px-3 py-2 text-[12px] text-dim2">读取目录中…</p>
      <p v-else-if="tree.error" role="alert" class="px-3 py-2 text-[12px] text-orange">{{ tree.error }}</p>
      <p v-else-if="rows.length === 0" class="px-3 py-2 text-[12px] text-dim2">这个目录是空的</p>

      <div v-else class="min-h-0 flex-1 overflow-auto py-1">
        <Hint v-for="row in rows" :key="row.node.path" :text="row.node.path" multiline>
          <button
            type="button"
            data-testid="file-tree-row"
            data-ctx="file-row"
            :data-path="row.node.path"
            :data-kind="row.node.kind"
            class="flex h-[26px] w-full cursor-pointer items-center gap-1 pe-2 text-start text-[12px] transition-colors hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
            :class="row.node.kind === 'directory' ? 'text-foreground' : 'text-dim hover:text-foreground'"
            :style="{ paddingInlineStart: `${8 + row.depth * 12}px` }"
            :aria-expanded="row.node.kind === 'directory' ? tree.isExpanded(row.node.path) : undefined"
            @click="activate(row.node)"
          >
            <span class="grid size-3.5 shrink-0 place-items-center text-dim2">
              <Icon
                v-if="row.node.kind === 'directory'"
                :name="tree.isLoading(row.node.path) ? 'refresh' : tree.isExpanded(row.node.path) ? 'down' : 'right'"
                :size="11"
              />
            </span>
            <template v-if="row.node.kind === 'directory'">
              <img
                :src="folderIconUrl(row.node.name, tree.isExpanded(row.node.path))"
                :alt="tree.isExpanded(row.node.path) ? '展开的文件夹' : '文件夹'"
                class="size-3.5 shrink-0 object-contain"
                :class="{ 'animate-spin opacity-60': tree.isLoading(row.node.path) }"
                draggable="false"
              />
            </template>
            <img v-else :src="fileIconUrl(row.node.name)" alt="文件" class="size-3.5 shrink-0 object-contain" draggable="false" />
            <span class="min-w-0 flex-1 truncate">{{ row.node.name }}</span>
          </button>
        </Hint>
      </div>
    </div>
  </ContextMenuRegion>
</template>
