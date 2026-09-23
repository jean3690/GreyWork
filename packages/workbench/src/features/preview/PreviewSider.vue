<script setup lang="ts">
/**
 * 右侧面板外壳：区段切换（文件 / 预览）+ 宽度 / 折叠 / 拖拽把手。
 *
 * 与左侧栏（`Sider.vue`）对称：**折叠即宽度归零并保持挂载**，靠 `overflow-hidden`
 * 兜住子元素。不卸载是关键 —— 卸载会让 CodeMirror / Univer 实例连同滚动位置一起丢，
 * 折叠再展开等于重新加载一遍。
 *
 * 拖拽把手贴在**左边缘**，所以 `useResizableSplit` 传 `reverse: true`（向左拖变宽）。
 * 把手是 12px 宽的透明热区，视觉上只有 2px 的线：热区太窄会变成「像素级瞄准游戏」。
 *
 * 区段切换是本地状态，但「有新的激活 tab」会自动跳到预览区 —— 与面板自动展开同一逻辑：
 * 用户或管线刚打开一个文件，就该看见它，而不是停在文件列表上。`artifact:updated`
 * 不改 activeId，所以后台就地更新不会把人从文件树里拽走。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { isTauriRuntime } from "@greywork/core";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import FileTree from "@/features/preview/FileTree.vue";
import GitChangePanel from "@/features/preview/GitChangePanel.vue";
import PreviewSurface from "@/features/preview/PreviewSurface.vue";
import WebFetchDialog from "@/features/preview/WebFetchDialog.vue";
import ContextMenuRegion from "@/features/shared/ContextMenuRegion.vue";
import { DEFAULT_PREVIEW_PANEL_PX, MAX_PREVIEW_PANEL_PX, MIN_PREVIEW_PANEL_PX, PREVIEW_TAB_BAR_HEIGHT } from "@/lib/layout";
import { openWithSystemApp, resolveTabDiskPath } from "@/lib/open-external";
import { revealInFolder } from "@/lib/reveal";
import { copyText } from "@/lib/clipboard";
import { buildPreviewEmptyItems, buildPreviewTabItems, type ContextMenuItem, type ContextTarget } from "@/lib/context-menu";
import { usePreviewBridge } from "@/lib/preview-bridge";
import { useResizableSplit } from "@/lib/resizable-split";
import { usePreviewStore, type PreviewTab } from "@/stores/preview";
import { notify } from "@/stores/notice";
import { isPreviewDirty, previewSaver } from "@/lib/preview-save";
import { cancelDiscard, confirmDiscard, pendingDiscard, requestLeave } from "@/lib/preview-edit-guard";
import { syncUnsavedChanges } from "@/lib/close-guard";
import ConfirmDialog from "@/features/settings/ConfirmDialog.vue";
import { i18n } from "@/i18n";

type Section = "files" | "preview" | "git";

const preview = usePreviewStore();
/** 外壳组件不装 i18n 插件也要能渲染（测试直接 mount 本组件），故用全局实例而非 useI18n。 */
const t = i18n.global.t;

// 事件订阅挂在组件作用域内，随卸载解绑（详见 preview-bridge.ts）。
usePreviewBridge();

const section = ref<Section>("preview");
const fetchDialogOpen = ref(false);

watch(
  () => preview.activeId,
  (id) => {
    if (id) section.value = "preview";
  },
);

/**
 * 区段切换：先过守卫再切。
 *
 * 区段用 `v-if` 切，离开预览区就会卸载编辑器并注销 saver —— 未保存的编辑随之消失
 * （此前只对「关标签」做了确认，切区段是条静默丢改动的路）。走 requestLeave 让它先自动
 * 保存，写不进去才弹确认。切到当前区段直接返回，省掉一次无意义的写盘。
 */
function switchSection(next: Section): void {
  if (next === section.value) return;
  requestLeave(() => (section.value = next));
}

const { dragging, onPointerDown } = useResizableSplit({
  width: () => preview.widthPx,
  onWidth: (px, commit) => preview.setWidth(px, commit),
  reverse: true,
});

const widthStyle = computed(() => ({ width: `${preview.effectiveWidthPx}px` }));

/**
 * 当前 tab 的磁盘孪生路径，没有则 null（按钮不出现）。
 * 浏览器态恒为 null：没有磁盘通道，按钮留着只会点了没反应。
 */
const externalPath = computed(() => {
  const tab = preview.activeTab;
  if (!tab || !isTauriRuntime()) return null;
  return resolveTabDiskPath(tab);
});

/** 用系统应用打开；缺省取当前 tab 的磁盘孪生路径（标题栏按钮走缺省，右键菜单传具体路径）。 */
async function openExternal(path = externalPath.value): Promise<void> {
  if (!path) return;
  if (await openWithSystemApp(path)) return;
  notify({
    kind: "warning",
    key: "preview-open-external",
    title: t("fileOp.openFailed"),
    detail: t("fileOp.openFailedDetail", { path }),
  });
}

async function revealPath(path: string): Promise<void> {
  if (await revealInFolder(path)) return;
  notify({
    kind: "warning",
    key: "preview-reveal",
    title: t("fileOp.revealFailed"),
    detail: t("fileOp.revealFailedDetail", { path }),
  });
}

/* ===== 右键菜单 =====
 * 标签条与预览空态是两个**兄弟** root（各自只包自己那层元素）：区域之间不得嵌套，
 * 否则 reka 的 trigger 冒泡会让内外两个菜单同时打开（见 lib/context-menu.ts 顶部）。
 * 预览内容区（PreviewSurface）刻意不包 —— 它的右键属于第三方查看器（如 Univer 表格）。 */
function tabById(id: string): PreviewTab | undefined {
  return preview.tabs.find((tab) => tab.id === id);
}

function diskPathOf(id: string): string | null {
  const tab = tabById(id);
  return tab ? resolveTabDiskPath(tab) : null;
}

function buildTabMenu(target: ContextTarget | null): ContextMenuItem[] {
  return buildPreviewTabItems(target, t, {
    activate: (id) => activateTab(id),
    reload: (id) => {
      const tab = tabById(id);
      if (tab) reloadTab(tab.path);
    },
    close: (id) => requestClose({ kind: "one", id }),
    closeOthers: (id) => requestClose({ kind: "others", id }),
    closeAll: () => requestClose({ kind: "all" }),
    copyPath: (text) => void copyText(text),
    openExternal: (path) => void openExternal(path),
    reveal: (path) => void revealPath(path),
    diskPath: diskPathOf,
    displayPath: (id) => diskPathOf(id) ?? tabById(id)?.path ?? "",
    hasMultiple: preview.tabs.length > 1,
  });
}

function buildEmptyMenu(): ContextMenuItem[] {
  return buildPreviewEmptyItems(t, {
    openFiles: () => switchSection("files"),
    fetchWeb: () => (fetchDialogOpen.value = true),
    closeAll: () => requestClose({ kind: "all" }),
    hasTabs: preview.tabs.length > 0,
  });
}

/** 双击把手复位到默认宽度：比「拖回大概位置」可靠，也是常见的分隔条约定。 */
function resetWidth(): void {
  preview.setWidth(DEFAULT_PREVIEW_PANEL_PX, true);
}

/** 中键关闭 tab：`button === 1` 是中键；preventDefault 拦掉浏览器默认的自动滚动。 */
function onTabAuxclick(event: MouseEvent, id: string): void {
  if (event.button !== 1) return;
  event.preventDefault();
  requestClose({ kind: "one", id });
}

/* ===== 保存 / 离开前兜住未保存改动 ===== */

/**
 * 关闭动作：单个 / 除某个外全部 / 全部。
 * 只描述「关哪些」，不关心怎么关 —— 守卫会先尝试保存，失败才问用户。
 */
type CloseAction = { kind: "one"; id: string } | { kind: "others"; id: string } | { kind: "all" };

/** 保存在途：禁用保存按钮防重复点击，也让 Ctrl+S 在写盘期间空转。 */
const saving = ref(false);

function performClose(action: CloseAction): void {
  if (action.kind === "one") preview.close(action.id);
  else if (action.kind === "others") preview.closeOthers(action.id);
  else preview.closeAll();
}

/**
 * 关闭入口：交给守卫先自动保存，写不进去才弹「放弃并继续」。
 * 之前的实现是「脏了就无条件问要不要放弃」，与切区段/切标签的静默丢改动不一致；
 * 现在几条离开路径共用一个策略：能存就存，存不了才问。
 */
function requestClose(action: CloseAction): void {
  requestLeave(() => performClose(action));
}

/** 激活另一个 tab：同样先过守卫（切 tab 会卸载当前编辑器）。 */
function activateTab(id: string): void {
  if (id === preview.activeId) return;
  requestLeave(() => preview.activate(id));
}

/**
 * 重新加载某路径：也先过守卫。
 *
 * 「重新加载」会重建 viewer（Univer / contenteditable 实例全丢），脏改动会无声消失。
 * 先自动保存再重读，用户拿到的是「已保存的内容」——既没丢改动，也达到了刷新目的。
 */
function reloadTab(path: string): void {
  requestLeave(() => preview.reload(path));
}

/** 待确认弹层里未能保存的 tab 名（文案用）。 */
const discardNames = computed(() => pendingDiscard.value?.failed.map((tab) => tab.name).join("、") ?? "");

/** 展开成模板可直接读的布尔，省得依赖「导入的 ref 在模板里自动解包」这条细节。 */
const discardOpen = computed(() => pendingDiscard.value !== null);

/** 当前激活 tab 是否有未保存改动（保存按钮可用态、Ctrl+S 拦截判据）。 */
const activeDirty = computed(() => (preview.activeTab ? isPreviewDirty(preview.activeTab.id) : false));

/** 全部 tab 的未保存改动数。 */
const dirtyCount = computed(() => preview.tabs.filter((tab) => isPreviewDirty(tab.id)).length);

/**
 * 把「有没有未保存改动」同步给宿主 —— 宿主只认这一个布尔，据此决定要不要在
 * `ExitRequested`（托盘退出 / Cmd+Q）里拦下。immediate 让启动后的真值先落地。
 */
watch(dirtyCount, (count) => void syncUnsavedChanges(count > 0), { immediate: true });

/** 保存当前激活 tab；失败弹通知 —— 吞掉会让用户误以为存住了。 */
async function saveActive(): Promise<void> {
  const tab = preview.activeTab;
  if (!tab || saving.value) return;
  const saver = previewSaver(tab.id);
  if (!saver || !saver.dirty.value) return;
  saving.value = true;
  try {
    await saver.save();
    notify({ kind: "success", key: "preview-save", title: t("common.saved"), detail: tab.name });
  } catch (cause) {
    notify({
      kind: "warning",
      key: "preview-save",
      title: t("preview.sider.saveFailed"),
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  } finally {
    saving.value = false;
  }
}

/** Ctrl/Cmd+S 保存当前 tab；只在有脏编辑器时拦截，不抢走其它场景的 Ctrl+S。 */
function onWindowKeydown(event: KeyboardEvent): void {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
  if (!activeDirty.value) return;
  event.preventDefault();
  void saveActive();
}

onMounted(() => window.addEventListener("keydown", onWindowKeydown));
onUnmounted(() => window.removeEventListener("keydown", onWindowKeydown));

/**
 * tab 拖拽排序：dragstart 记下被拖的 tab，dragover 只是允许放置，
 * drop 时按落点下标提交 store（重排不动 activeId，不抢焦点）。
 * dataTransfer 里塞 path 只是让拖拽影像合法（Firefox 要求非空 dataTransfer 才触发 dragstart）。
 */
const draggingTabId = ref<string | null>(null);

function onTabDragStart(event: DragEvent, tab: PreviewTab): void {
  draggingTabId.value = tab.id;
  event.dataTransfer?.setData("text/plain", tab.path);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onTabDrop(event: DragEvent, index: number): void {
  event.preventDefault();
  const id = draggingTabId.value;
  draggingTabId.value = null;
  if (id) preview.moveTab(id, index);
}

/** 键盘调宽：方向键 ±8px（Shift 步进 40），Home/End 到上下限。 */
function onResizeKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? 40 : 8;
  let next: number | null = null;
  if (event.key === "ArrowLeft") next = preview.widthPx - step;
  else if (event.key === "ArrowRight") next = preview.widthPx + step;
  else if (event.key === "Home") next = MIN_PREVIEW_PANEL_PX;
  else if (event.key === "End") next = MAX_PREVIEW_PANEL_PX;
  if (next === null) return;
  event.preventDefault();
  preview.setWidth(next, true);
}

const sectionClass = (active: boolean): string =>
  [
    "h-6 shrink-0 cursor-pointer rounded-[6px] px-2 text-[11.5px] transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan",
    active ? "bg-panel text-foreground" : "text-dim hover:text-foreground",
  ].join(" ");
</script>

<template>
  <aside
    data-testid="preview-sider"
    class="relative flex shrink-0 flex-col overflow-hidden bg-panel-2 transition-[width] duration-150"
    :class="preview.collapsed ? 'border-l-0' : 'border-l border-line-2'"
    :style="widthStyle"
    :aria-hidden="preview.collapsed ? 'true' : undefined"
  >
    <!-- 拖拽把手：折叠时不渲染（没有可拖的宽度，留着只会挡住会话区右边缘的点击） -->
    <div
      v-if="!preview.collapsed"
      class="group absolute inset-y-0 left-0 z-20 flex w-3 cursor-col-resize items-center justify-start"
      data-testid="preview-resize-handle"
      role="separator"
      aria-orientation="vertical"
      :aria-label="t('preview.sider.resize')"
      :aria-valuemin="MIN_PREVIEW_PANEL_PX"
      :aria-valuemax="MAX_PREVIEW_PANEL_PX"
      :aria-valuenow="preview.widthPx"
      tabindex="0"
      @keydown="onResizeKeydown"
      @pointerdown="onPointerDown"
      @dblclick="resetWidth"
    >
      <span
        class="pointer-events-none block h-full w-0.5 rounded-full transition-all duration-150"
        :class="dragging ? 'w-1 bg-cyan' : 'bg-line-2 group-hover:w-1 group-hover:bg-cyan'"
      />
    </div>

    <!-- 区段切换条 -->
    <div class="flex shrink-0 items-center gap-1 border-b border-line ps-4 pe-1" :style="{ height: `${PREVIEW_TAB_BAR_HEIGHT}px` }">
      <button
        type="button"
        data-testid="preview-section-files"
        :class="sectionClass(section === 'files')"
        :aria-current="section === 'files' ? 'true' : undefined"
        @click="switchSection('files')"
      >
        {{ t("preview.sider.sectionFiles") }}
      </button>
      <button
        type="button"
        data-testid="preview-section-preview"
        :class="sectionClass(section === 'preview')"
        :aria-current="section === 'preview' ? 'true' : undefined"
        @click="switchSection('preview')"
      >
        {{ t("preview.sider.sectionPreview") }}<span v-if="preview.tabs.length" class="ms-1 text-dim2">{{ preview.tabs.length }}</span>
      </button>
      <button
        type="button"
        data-testid="preview-section-git"
        :class="sectionClass(section === 'git')"
        :aria-current="section === 'git' ? 'true' : undefined"
        @click="switchSection('git')"
      >
        {{ t("preview.sider.sectionGit") }}
      </button>

      <div class="ms-auto flex shrink-0 items-center gap-0.5">
        <button
          v-if="section === 'preview' && activeDirty"
          type="button"
          data-testid="preview-save"
          :aria-disabled="saving || undefined"
          class="grid size-6 cursor-pointer place-items-center rounded-[6px] text-cyan transition-colors hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan aria-disabled:cursor-not-allowed aria-disabled:text-dim2"
          :aria-label="t('preview.sider.saveCurrent')"
          @click="saveActive()"
        >
          <Icon name="save" :size="13" />
        </button>
        <button
          type="button"
          data-testid="web-fetch-open"
          class="grid size-6 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          :aria-label="t('preview.sider.fetchWeb')"
          @click="fetchDialogOpen = true"
        >
          <Icon name="earth" :size="13" />
        </button>
        <button
          v-if="section === 'preview' && preview.activeTab"
          type="button"
          data-testid="preview-reload"
          class="grid size-6 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          :aria-label="t('preview.sider.reloadCurrent')"
          @click="reloadTab(preview.activeTab.path)"
        >
          <Icon name="refresh" :size="13" />
        </button>
        <Hint v-if="externalPath" :text="t('preview.sider.openExternalHint', { path: externalPath })" multiline>
          <button
            type="button"
            data-testid="preview-open-external"
            class="grid size-6 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
            :aria-label="t('preview.common.openExternal')"
            @click="openExternal()"
          >
            <Icon name="external" :size="13" />
          </button>
        </Hint>
        <button
          v-if="section === 'preview' && preview.tabs.length > 1"
          type="button"
          data-testid="preview-close-all"
          class="grid size-6 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          :aria-label="t('preview.sider.closeAll')"
          @click="requestClose({ kind: 'all' })"
        >
          <Icon name="close-one" :size="13" />
        </button>
        <button
          type="button"
          data-testid="preview-collapse"
          class="grid size-6 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          :aria-label="t('preview.sider.collapse')"
          @click="preview.setCollapsed(true)"
        >
          <Icon name="expand-right" :size="13" />
        </button>
      </div>
    </div>

    <FileTree v-if="section === 'files'" class="min-h-0 flex-1" />

    <GitChangePanel v-else-if="section === 'git'" class="min-h-0 flex-1" />

    <template v-else>
      <!-- tab 条：左侧 tab 溢出横向滚动；支持中键关闭与拖拽重排 -->
      <ContextMenuRegion v-if="preview.tabs.length" :build="buildTabMenu">
        <div class="flex h-7 shrink-0 items-center gap-1 overflow-x-auto border-b border-line ps-4 pe-1">
          <div
            v-for="(tab, index) in preview.tabs"
            :key="tab.id"
            data-testid="preview-tab"
            data-ctx="preview-tab"
            :data-tab-id="tab.id"
            draggable="true"
            class="flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-[11.5px] transition-colors"
            :class="[
              tab.id === preview.activeId ? 'bg-panel text-foreground' : 'text-dim hover:text-foreground',
              draggingTabId && draggingTabId !== tab.id ? 'opacity-60' : '',
            ]"
            @dragstart="onTabDragStart($event, tab)"
            @dragover.prevent
            @drop="onTabDrop($event, index)"
            @dragend="draggingTabId = null"
            @auxclick="onTabAuxclick($event, tab.id)"
          >
            <Hint :text="tab.path" multiline>
              <button
                type="button"
                class="max-w-[160px] cursor-pointer truncate focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
                :aria-label="t('preview.sider.viewTab', { name: tab.name })"
                :aria-current="tab.id === preview.activeId ? 'true' : undefined"
                @click="activateTab(tab.id)"
              >
                {{ tab.name }}
              </button>
            </Hint>
            <span
              v-if="isPreviewDirty(tab.id)"
              data-testid="preview-tab-dirty"
              class="size-1.5 shrink-0 rounded-full bg-cyan"
              aria-hidden="true"
              :title="t('preview.sider.dirty')"
            />
            <button
              type="button"
              data-testid="preview-tab-close"
              class="grid size-4 cursor-pointer place-items-center rounded-[4px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
              :aria-label="t('preview.sider.closeTab', { name: tab.name })"
              @click.stop="requestClose({ kind: 'one', id: tab.id })"
            >
              <Icon name="close" :size="10" />
            </button>
          </div>
        </div>
      </ContextMenuRegion>

      <div class="min-h-0 flex-1 overflow-hidden">
        <PreviewSurface v-if="preview.activeTab" :tab="preview.activeTab" />
        <ContextMenuRegion v-else :build="buildEmptyMenu">
          <div data-testid="preview-empty" class="flex size-full flex-col items-center justify-center gap-2 px-4 text-center">
            <span class="text-[12px] text-dim2">{{ t("preview.sider.emptyTitle") }}</span>
            <span class="text-[11px] text-dim2">{{ t("preview.sider.emptyHint") }}</span>
            <div class="mt-1 flex items-center gap-2">
              <button
                type="button"
                data-testid="preview-empty-files"
                class="cursor-pointer rounded-[6px] border border-line-2 bg-panel px-2.5 py-1 text-[11.5px] text-dim transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
                @click="switchSection('files')"
              >
                {{ t("preview.sider.openFiles") }}
              </button>
              <button
                type="button"
                data-testid="preview-empty-fetch"
                class="cursor-pointer rounded-[6px] border border-line-2 bg-panel px-2.5 py-1 text-[11.5px] text-dim transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
                @click="fetchDialogOpen = true"
              >
                {{ t("preview.sider.fetchWeb") }}
              </button>
            </div>
          </div>
        </ContextMenuRegion>
      </div>
    </template>

    <WebFetchDialog v-if="fetchDialogOpen" @close="fetchDialogOpen = false" />

    <ConfirmDialog
      v-if="discardOpen"
      :title="t('preview.guard.title')"
      :message="t('preview.guard.message', { names: discardNames })"
      :confirm-label="t('preview.guard.confirm')"
      @confirm="confirmDiscard"
      @cancel="cancelDiscard"
    />
  </aside>
</template>
