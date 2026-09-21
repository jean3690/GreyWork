/**
 * 右键菜单的条目契约 + 各区域的条目构建器。
 *
 * 为什么是「条目数组 + 一个通用区域组件」而不是全局单例菜单：reka 的
 * ContextMenuTrigger 自带指针定位 / portal / 焦点陷阱 / 外部点击关闭，全局单例要把
 * 这四件事自己重写一遍，而且和本项目的多窗口模型（#/plugin-window）冲突。
 *
 * 两条与 reka 实现耦合的行为约定（改前先看 reka 的 ContextMenu/ContextMenuTrigger.js）：
 *
 * 1. 捕获处理器**有**条目时绝不能 preventDefault —— reka 在 `await nextTick()` 之后才检查
 *    `event.defaultPrevented`，被拦掉就整段跳过（菜单不打开）。
 * 2. **无**条目时主动 preventDefault：既抑制空菜单，也顺手把原生右键菜单拦掉。
 *
 * 区域切分的硬约束：ContextMenuTrigger 不做 stopPropagation，嵌套的两层会**同时**打开。
 * 所以一个区域只放一个 root，且各区域的 root 之间不得互相包含（见各组件里的 data-ctx 标注）。
 */

/** i18n 翻译函数的最小面；组件传 `t` 进来，构建器本身不碰 i18n 实例。 */
export type Translate = (key: string) => string;

export type ContextMenuItem =
  | {
      kind: "item";
      label: string;
      icon?: string;
      disabled?: boolean;
      /** 破坏性动作（删除）：用主题的 destructive 色。 */
      destructive?: boolean;
      onSelect: () => void;
    }
  | { kind: "separator" }
  | { kind: "label"; label: string };

export function item(
  label: string,
  onSelect: () => void,
  options: { icon?: string; disabled?: boolean; destructive?: boolean } = {},
): ContextMenuItem {
  return { kind: "item", label, onSelect, ...options };
}

export function separator(): ContextMenuItem {
  return { kind: "separator" };
}

/** 命中的右键目标：`data-ctx` 的值 + 承载该标记的元素。 */
export interface ContextTarget {
  ctx: string;
  el: HTMLElement;
}

/**
 * 从右键事件目标向上找最近的 `[data-ctx]`。
 *
 * 区域 root 就是 reka 的 trigger，事件目标可能是行内的图标 / 文本节点宿主，
 * 所以要向上回溯到带标记的那一层再读它的 data-*。
 */
export function contextTarget(target: EventTarget | null): ContextTarget | null {
  if (!(target instanceof HTMLElement)) return null;
  const el = target.closest<HTMLElement>("[data-ctx]");
  if (!el) return null;
  const ctx = el.dataset.ctx;
  return ctx ? { ctx, el } : null;
}

/** 判定命中目标的 data-ctx 是否为某值；不是则返回 null（调用方据此回退到「区域空白」菜单）。 */
function hitOf(target: ContextTarget | null, ctx: string): HTMLElement | null {
  return target && target.ctx === ctx ? target.el : null;
}

/* ===================== 文件树 ===================== */

export interface FileTreeMenuActions {
  /** 打开：目录展开/收起，文件进预览。 */
  activate: (path: string, kind: "file" | "directory") => void;
  refresh: () => void;
  /** 只有磁盘源才有磁盘孪生路径；vfs 产物不给「系统应用打开 / 在文件夹中显示」。 */
  canUseDisk: boolean;
  openExternal: (path: string) => void;
  reveal: (path: string) => void;
  copyPath: (path: string) => void;
}

export function buildFileTreeItems(target: ContextTarget | null, t: Translate, actions: FileTreeMenuActions): ContextMenuItem[] {
  const row = hitOf(target, "file-row");
  // 空白区（含根提示条）：只给「刷新」，不给一堆对不上目标的项。
  if (!row) return [item(t("contextMenu.fileTree.refresh"), actions.refresh, { icon: "refresh" })];

  const path = row.dataset.path ?? "";
  const isDirectory = row.dataset.kind === "directory";
  const entries: ContextMenuItem[] = [
    item(t("contextMenu.fileTree.open"), () => actions.activate(path, isDirectory ? "directory" : "file"), {
      icon: isDirectory ? "folder" : "file",
    }),
  ];
  if (actions.canUseDisk) {
    entries.push(
      // 目录交给系统文件管理器更自然，这里只对文件提供「用系统应用打开」。
      item(t("contextMenu.fileTree.openExternal"), () => actions.openExternal(path), { icon: "external", disabled: isDirectory }),
      item(t("contextMenu.fileTree.reveal"), () => actions.reveal(path), { icon: "folder" }),
    );
  }
  entries.push(
    separator(),
    item(t("contextMenu.fileTree.copyPath"), () => actions.copyPath(path), { icon: "file" }),
    separator(),
    item(t("contextMenu.fileTree.refresh"), actions.refresh, { icon: "refresh" }),
  );
  return entries;
}

/* ===================== 预览标签 / 预览空态 ===================== */

export interface PreviewTabMenuActions {
  activate: (id: string) => void;
  reload: (id: string) => void;
  close: (id: string) => void;
  closeOthers: (id: string) => void;
  closeAll: () => void;
  copyPath: (text: string) => void;
  openExternal: (path: string) => void;
  reveal: (path: string) => void;
  /** 标签的磁盘孪生路径；null = 纯内存产物 / 网页，相关项不出现。 */
  diskPath: (id: string) => string | null;
  /** 标签展示用路径（磁盘路径或 vfs 路径），用于「复制路径」。 */
  displayPath: (id: string) => string;
  /** 是否有多个标签（决定「关闭其他」是否可用）。 */
  hasMultiple: boolean;
}

export function buildPreviewTabItems(target: ContextTarget | null, t: Translate, actions: PreviewTabMenuActions): ContextMenuItem[] {
  const tab = hitOf(target, "preview-tab");
  if (!tab) return [];
  const id = tab.dataset.tabId ?? "";
  if (!id) return [];

  const diskPath = actions.diskPath(id);
  const entries: ContextMenuItem[] = [
    item(t("contextMenu.previewTab.activate"), () => actions.activate(id), { icon: "expand-right" }),
    separator(),
    item(t("contextMenu.previewTab.reload"), () => actions.reload(id), { icon: "refresh" }),
  ];
  if (diskPath) {
    entries.push(
      item(t("contextMenu.previewTab.openExternal"), () => actions.openExternal(diskPath), { icon: "external" }),
      item(t("contextMenu.previewTab.reveal"), () => actions.reveal(diskPath), { icon: "folder" }),
    );
  }
  entries.push(
    item(t("contextMenu.previewTab.copyPath"), () => actions.copyPath(actions.displayPath(id)), { icon: "file" }),
    separator(),
    item(t("contextMenu.previewTab.close"), () => actions.close(id), { icon: "close" }),
    item(t("contextMenu.previewTab.closeOthers"), () => actions.closeOthers(id), {
      icon: "close-one",
      disabled: !actions.hasMultiple,
    }),
    item(t("contextMenu.previewTab.closeAll"), actions.closeAll, { icon: "close-one" }),
  );
  return entries;
}

export interface PreviewEmptyMenuActions {
  openFiles: () => void;
  fetchWeb: () => void;
  closeAll: () => void;
  hasTabs: boolean;
}

export function buildPreviewEmptyItems(t: Translate, actions: PreviewEmptyMenuActions): ContextMenuItem[] {
  const entries: ContextMenuItem[] = [
    item(t("contextMenu.previewEmpty.openFiles"), actions.openFiles, { icon: "folder" }),
    item(t("contextMenu.previewEmpty.fetchWeb"), actions.fetchWeb, { icon: "earth" }),
  ];
  if (actions.hasTabs) {
    entries.push(separator(), item(t("contextMenu.previewEmpty.closeAll"), actions.closeAll, { icon: "close-one" }));
  }
  return entries;
}

/* ===================== 会话历史行 ===================== */

export interface HistoryRowMenuActions {
  rename: () => void;
  copyTitle: () => void;
  remove: () => void;
}

/** 每行一个 root，动作直接来自行内既有处理器（重命名输入框 / 删除二次确认都在行里）。 */
export function buildHistoryRowItems(t: Translate, actions: HistoryRowMenuActions): ContextMenuItem[] {
  return [
    item(t("contextMenu.historyRow.rename"), actions.rename, { icon: "edit" }),
    item(t("contextMenu.historyRow.copyTitle"), actions.copyTitle, { icon: "file" }),
    separator(),
    item(t("contextMenu.historyRow.delete"), actions.remove, { icon: "delete", destructive: true }),
  ];
}

/* ===================== 聊天消息 ===================== */

export interface MessageMenuActions {
  copyBody: (text: string) => void;
}

/** content 为空（纯占位 / 只带卡片的消息）返回空表 → 该次右键被抑制。 */
export function buildMessageItems(content: string | null, t: Translate, actions: MessageMenuActions): ContextMenuItem[] {
  if (!content) return [];
  return [item(t("contextMenu.message.copyBody"), () => actions.copyBody(content), { icon: "file" })];
}

/* ===================== 输入框 ===================== */

export interface ComposerMenuActions {
  cut: () => void;
  copy: () => void;
  paste: () => void;
  selectAll: () => void;
  /** 无选区时「剪切 / 复制」禁用（与原生菜单一致）。 */
  hasSelection: boolean;
}

export function buildComposerItems(t: Translate, actions: ComposerMenuActions): ContextMenuItem[] {
  return [
    item(t("contextMenu.composer.cut"), actions.cut, { icon: "close-one", disabled: !actions.hasSelection }),
    item(t("contextMenu.composer.copy"), actions.copy, { icon: "file", disabled: !actions.hasSelection }),
    item(t("contextMenu.composer.paste"), actions.paste, { icon: "plus" }),
    separator(),
    item(t("contextMenu.composer.selectAll"), actions.selectAll, { icon: "check-one" }),
  ];
}

/* ===================== 标题栏 ===================== */

export interface TitlebarMenuActions {
  toggleSidebar: () => void;
  togglePreview: () => void;
  toggleWorkspace: () => void;
  toggleActivity: () => void;
  newChat: () => void;
  openSettings: () => void;
  /** 面板可用性 / 折叠态：不可用的面板项直接禁用（与标题栏按钮的显隐同源）。 */
  previewAvailable: boolean;
  workspaceAvailable: boolean;
  activityAvailable: boolean;
}

export function buildTitlebarItems(t: Translate, actions: TitlebarMenuActions): ContextMenuItem[] {
  return [
    item(t("contextMenu.titlebar.toggleSidebar"), actions.toggleSidebar, { icon: "sidebar" }),
    item(t("contextMenu.titlebar.togglePreview"), actions.togglePreview, { icon: "sidebar", disabled: !actions.previewAvailable }),
    item(t("contextMenu.titlebar.toggleWorkspace"), actions.toggleWorkspace, { icon: "folder", disabled: !actions.workspaceAvailable }),
    item(t("contextMenu.titlebar.toggleActivity"), actions.toggleActivity, { icon: "up", disabled: !actions.activityAvailable }),
    separator(),
    item(t("contextMenu.titlebar.newChat"), actions.newChat, { icon: "plus" }),
    item(t("contextMenu.titlebar.openSettings"), actions.openSettings, { icon: "setting" }),
  ];
}

/* ===================== 侧栏导航区 ===================== */

export interface SiderNavMenuActions {
  newChat: () => void;
  openSettings: () => void;
  toggleSidebar: () => void;
}

export function buildSiderNavItems(t: Translate, actions: SiderNavMenuActions): ContextMenuItem[] {
  return [
    item(t("contextMenu.siderNav.newChat"), actions.newChat, { icon: "plus" }),
    item(t("contextMenu.siderNav.openSettings"), actions.openSettings, { icon: "setting" }),
    separator(),
    item(t("contextMenu.siderNav.collapseSidebar"), actions.toggleSidebar, { icon: "expand-right" }),
  ];
}

/* ===================== 活动带标签 ===================== */

export interface ActivityTabMenuActions {
  activate: (id: string) => void;
  collapse: () => void;
}

export function buildActivityTabItems(target: ContextTarget | null, t: Translate, actions: ActivityTabMenuActions): ContextMenuItem[] {
  const tab = hitOf(target, "activity-tab");
  const entries: ContextMenuItem[] = [];
  const id = tab?.dataset.tabId ?? "";
  if (id)
    entries.push(
      item(t("contextMenu.activityTab.activate"), () => actions.activate(id), { icon: "expand-right" }),
      separator(),
    );
  entries.push(item(t("contextMenu.activityTab.collapse"), actions.collapse, { icon: "down" }));
  return entries;
}
