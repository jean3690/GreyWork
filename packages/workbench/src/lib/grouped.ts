/**
 * 会话历史分组：把 store 里的扁平会话按工作区分组，产出侧栏工作区列表的每一行。
 *
 * 侧栏那份列表既是浏览面也是切换器，所以无关键字时**每个工作区都出一行**（含 0 会话的），
 * 且「普通对话」兜底行恒在最后（p-general 与未绑定 null 的会话合并进去）。
 * 有关键字时退化成搜索结果：无命中会话的行整行隐去。
 */

export interface HistorySession {
  id: string;
  title: string;
  updatedAt: number;
}

export interface HistoryGroup {
  id: string | null;
  name: string;
  /** 兜底行（p-general + 未绑定会话）：没有存放文件夹，不可重命名 / 换绑 / 删除。 */
  general: boolean;
  /** 工作区自定义图标名；undefined = UI 按 general 与否兜底到 message / folder。 */
  icon?: string;
  sessions: HistorySession[];
}

export interface GroupingInput {
  /** 展示用工作区（含 p-general；可按 id 过滤哪些参与分组）。 */
  workspaces: { id: string; name: string; icon?: string }[];
  /** 会话 → 归属工作区 id（null = 未绑定）。 */
  sessions: { id: string; title: string; updatedAt: number; workspaceId: string | null }[];
  /** 按标题过滤关键字（小写已归一）。 */
  keyword?: string;
}

export function groupSessions(input: GroupingInput): HistoryGroup[] {
  const keyword = (input.keyword ?? "").trim().toLowerCase();
  const generalId = input.workspaces.find((workspace) => workspace.id === "p-general")?.id ?? null;

  const groupOf = (workspaceId: string | null): HistorySession[] =>
    input.sessions
      .filter((session) => session.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((session) => ({ id: session.id, title: session.title, updatedAt: session.updatedAt }))
      .filter((row) => !keyword || row.title.toLowerCase().includes(keyword));

  const groups: HistoryGroup[] = input.workspaces
    .filter((workspace) => workspace.id !== "p-general")
    .map((workspace) => ({ id: workspace.id, name: workspace.name, general: false, icon: workspace.icon, sessions: groupOf(workspace.id) }))
    // 只有搜索时才丢空行：平时空工作区也得在列表里，它是可切换的落点
    .filter((group) => !keyword || group.sessions.length > 0);

  const freeRows = groupOf(null);
  const generalRows = generalId ? groupOf(generalId) : [];
  // 两路会话合并后重排：兜底行对外只承诺「按更新时间倒序」，不承诺 null 的排在 p-general 前
  const combined = [...freeRows, ...generalRows].sort((a, b) => b.updatedAt - a.updatedAt);
  if (!keyword || combined.length) {
    groups.push({ id: generalId, name: generalId ? "普通对话" : "未分组", general: true, sessions: combined });
  }
  return groups;
}
