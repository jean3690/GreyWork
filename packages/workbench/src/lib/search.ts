/**
 * 标题栏搜索：条目模型 + 纯检索/筛选/排序 + 索引构建。
 *
 * 全部是纯函数（store 只读访问在 `buildSearchItems` 的入参里显式传入），便于单测；
 * 渲染与交互在 `components/SearchPanel.vue`。
 *
 * 搜索面分两类：`session`（会话：标题 + 正文）与 `feature`（功能入口：侧栏导航 /
 * 设置分区）。混合排序时标题前缀命中优先，其次标题包含，再次描述与正文。
 *
 * 刻意不把斜杠命令收进来：它们是**输入态**的补全而非可去的目的地，选中之后无处可去。
 */
import type { SessionStatus } from "./session-status";

export type SearchKind = "session" | "nav" | "settings";
/** 用户可见的筛选大类：会话 vs 功能入口。 */
export type SearchType = "session" | "feature";

export interface SearchItem {
  id: string;
  kind: SearchKind;
  label: string;
  description?: string;
  /** 命中后跳转的路由（会话 / 导航 / 命令）。 */
  path?: string;
  /** 设置分区 key（kind === "settings"）；命中经 settings:open 事件打开弹窗。 */
  section?: string;
  /** 会话状态（kind === "session"）。 */
  status?: SessionStatus;
  /** 会话所属工作区（kind === "session"）。 */
  workspaceId?: string | null;
  /** 参与匹配但不在标题/描述上显示的文本（会话正文摘要等）。 */
  keywords?: string;
}

export interface SearchFilters {
  /** null / 缺省 = 全部类型。 */
  type?: SearchType | null;
  /** null / 缺省 = 全部状态（仅对会话生效）。 */
  status?: SessionStatus | null;
  /** 缺省 = 不过滤；null = 只看未绑定工作区的会话；字符串 = 该工作区的会话。 */
  workspaceId?: string | null;
}

const KIND_TYPE: Record<SearchKind, SearchType> = {
  session: "session",
  nav: "feature",
  settings: "feature",
};

export function typeOf(item: SearchItem): SearchType {
  return KIND_TYPE[item.kind];
}

/** 命中强度：标题前缀 3 > 标题包含 2 > 描述 1 > 正文/关键词 0.5 > 不命中 0。 */
export function scoreItem(item: SearchItem, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const label = item.label.toLowerCase();
  if (label.startsWith(needle)) return 3;
  if (label.includes(needle)) return 2;
  if ((item.description ?? "").toLowerCase().includes(needle)) return 1;
  if ((item.keywords ?? "").toLowerCase().includes(needle)) return 0.5;
  return 0;
}

/** 空查询视为全命中（此时列表是「浏览全部」，由筛选条决定看什么）。 */
export function matchesQuery(item: SearchItem, query: string): boolean {
  if (!query.trim()) return true;
  return scoreItem(item, query) > 0;
}

/** 按筛选条件过条目：类型 / 会话状态 / 工作区。 */
export function filterItems(items: SearchItem[], filters: SearchFilters = {}): SearchItem[] {
  return items.filter((item) => {
    if (filters.type && typeOf(item) !== filters.type) return false;
    // 状态筛选只对会话有意义：打开状态筛选时，功能入口一律不出现。
    if (filters.status) {
      if (item.kind !== "session" || item.status !== filters.status) return false;
    }
    // 工作区筛选同理；null 表示「未绑定工作区」（侧栏的「普通对话」）。
    if (filters.workspaceId !== undefined) {
      if (item.kind !== "session" || item.workspaceId !== filters.workspaceId) return false;
    }
    return true;
  });
}

/** 检索 = 先筛后排。空查询保持入参顺序（会话在前、功能在后）。 */
export function searchItems(items: SearchItem[], query: string, filters: SearchFilters = {}): SearchItem[] {
  const filtered = filterItems(items, filters);
  if (!query.trim()) return filtered;
  return filtered
    .filter((item) => matchesQuery(item, query))
    .map((item, index) => ({ item, index, score: scoreItem(item, query) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}

/** 会话正文参与检索的最近消息条数 / 字符上限：全量深扫会拖慢每次输入。 */
const SESSION_KEYWORD_MESSAGES = 8;
const SESSION_KEYWORD_CHARS = 2000;

/** 取会话最近若干条消息的正文作为检索语料（截断，避免超长会话把输入卡住）。 */
export function sessionKeywords(messages: readonly { content: string }[]): string {
  const joined = messages
    .slice(-SESSION_KEYWORD_MESSAGES)
    .map((message) => message.content)
    .filter(Boolean)
    .join("\n");
  return joined.slice(-SESSION_KEYWORD_CHARS);
}

export interface BuildSearchItemsInput {
  sessions: readonly { id: string; title: string; workspaceId: string | null; messages: readonly { content: string }[] }[];
  navItems: readonly { path: string; label: string }[];
  settingsSections: readonly { key: string; title: string; description?: string }[];
  /** 会话状态查询（由调用方注入 useSessionStatus，保持本模块纯净）。 */
  statusOf: (id: string) => SessionStatus;
}

/** 组装搜索索引：会话（标题 + 正文）在前，功能入口在后。 */
export function buildSearchItems(input: BuildSearchItemsInput): SearchItem[] {
  const sessions: SearchItem[] = input.sessions.map((session) => ({
    id: `session:${session.id}`,
    kind: "session",
    label: session.title,
    description: session.messages.at(-1)?.content?.slice(0, 80) || undefined,
    path: `/conversation/${session.id}`,
    status: input.statusOf(session.id),
    workspaceId: session.workspaceId,
    keywords: sessionKeywords(session.messages),
  }));

  const nav: SearchItem[] = input.navItems.map((item) => ({
    id: `nav:${item.path}`,
    kind: "nav",
    label: item.label,
    description: item.path,
    path: item.path,
  }));

  const settings: SearchItem[] = input.settingsSections.map((section) => ({
    id: `settings:${section.key}`,
    kind: "settings",
    label: section.title,
    description: section.description,
    section: section.key,
  }));

  return [...sessions, ...nav, ...settings];
}
