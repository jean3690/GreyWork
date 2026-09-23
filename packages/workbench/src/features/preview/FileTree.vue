<script setup lang="ts">
/**
 * 右栏「文件」区的树。
 *
 * 渲染用**展平 + 单层 v-for**，不用自引用递归组件：递归组件在深目录下会叠出几十层
 * 组件实例，而展平后只有一个列表，缩进靠 padding。行为完全一样，代价低一个量级。
 */
import { computed, onMounted, ref } from "vue";
import { isTauriRuntime } from "@greywork/core";
import { useVirtualizer } from "@tanstack/vue-virtual";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import ContextMenuRegion from "@/features/shared/ContextMenuRegion.vue";
import { fileIconUrl, folderIconUrl } from "@/lib/file-icons";
import { deviceTier } from "@/lib/device-tier";
import { observeNonZeroRect } from "@/lib/virtual-rect";
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

/* ===== 右键菜单 =====
 * 整棵树只挂一个 reka root，靠 data-ctx 认目标；逐行挂 root 会在深目录下叠出成百个
 * 组件实例。虚拟化后行会随滚动进出 DOM，菜单仍按 data-path 回查 rows，与挂载无关。
 * 条目构建在 lib/context-menu（可单测）。 */
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

      <div v-else ref="scrollEl" class="min-h-0 flex-1 overflow-auto py-1">
        <!-- 相对容器 + 显式总高：行一律绝对定位在 translateY 处，虚拟与非虚拟共用一套模板 -->
        <div class="relative" :style="{ height: `${totalHeight}px` }">
          <div
            v-for="slot in slots"
            :key="slot.key"
            :data-index="slot.index"
            class="absolute left-0 top-0 w-full"
            :style="{ transform: `translateY(${slot.start}px)` }"
          >
            <Hint :text="slot.row.node.path" multiline>
              <button
                type="button"
                data-testid="file-tree-row"
                data-ctx="file-row"
                :data-path="slot.row.node.path"
                :data-kind="slot.row.node.kind"
                class="flex h-[26px] w-full cursor-pointer items-center gap-1 pe-2 text-start text-[12px] transition-colors hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
                :class="slot.row.node.kind === 'directory' ? 'text-foreground' : 'text-dim hover:text-foreground'"
                :style="{ paddingInlineStart: `${8 + slot.row.depth * 12}px` }"
                :aria-expanded="slot.row.node.kind === 'directory' ? tree.isExpanded(slot.row.node.path) : undefined"
                @click="activate(slot.row.node)"
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
                    :alt="tree.isExpanded(slot.row.node.path) ? '展开的文件夹' : '文件夹'"
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
                  alt="文件"
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
</template>
