/**
 * 标题栏搜索的纯逻辑：命中评分 / 筛选 / 排序 / 索引构建。
 * 关键契约：空查询 = 浏览全部（由筛选条决定）；标题前缀命中排在包含命中之前；
 * 状态与工作区筛选只对会话生效（打开筛选时功能入口不混进来）。
 */
import { describe, expect, it } from "vitest";
import {
  buildSearchItems,
  filterItems,
  matchesQuery,
  scoreItem,
  searchItems,
  sessionKeywords,
  typeOf,
  type SearchItem,
} from "@/lib/search";

function item(partial: Partial<SearchItem> & { id: string; label: string }): SearchItem {
  return { kind: "session", ...partial };
}

const SESSION: SearchItem = item({
  id: "session:s1",
  label: "重构认证模块",
  kind: "session",
  description: "顺手补了测试",
  status: "done",
  workspaceId: "w-1",
  keywords: "jwt 刷新令牌",
});
const NAV: SearchItem = item({ id: "nav:/team", label: "团队", kind: "nav", path: "/team" });
const SETTINGS: SearchItem = item({ id: "settings:mcp", label: "MCP", kind: "settings", section: "mcp" });
const ALL = [SESSION, NAV, SETTINGS];

describe("scoreItem / matchesQuery", () => {
  it("标题前缀 > 标题包含 > 描述 > 正文关键词", () => {
    expect(scoreItem(SESSION, "重构")).toBe(3);
    expect(scoreItem(SESSION, "认证")).toBe(2);
    expect(scoreItem(SESSION, "顺手")).toBe(1);
    expect(scoreItem(SESSION, "jwt")).toBe(0.5);
    expect(scoreItem(SESSION, "不存在")).toBe(0);
  });

  it("大小写与首尾空白不影响命中", () => {
    const lower = item({ id: "n", label: "JWT 面板", kind: "nav" });
    expect(scoreItem(lower, "  jwt ")).toBe(3);
  });

  it("空查询全命中（浏览态）", () => {
    expect(matchesQuery(SESSION, "")).toBe(true);
    expect(matchesQuery(SESSION, "   ")).toBe(true);
  });
});

describe("typeOf / filterItems", () => {
  it("kind → 大类：会话 / 功能", () => {
    expect(typeOf(SESSION)).toBe("session");
    expect(typeOf(NAV)).toBe("feature");
    expect(typeOf(SETTINGS)).toBe("feature");
  });

  it("类型筛选", () => {
    expect(filterItems(ALL, { type: "feature" }).map((entry) => entry.id)).toEqual(["nav:/team", "settings:mcp"]);
    expect(filterItems(ALL, { type: "session" }).map((entry) => entry.id)).toEqual(["session:s1"]);
  });

  it("状态筛选只留会话，且状态要匹配", () => {
    expect(filterItems(ALL, { status: "done" }).map((entry) => entry.id)).toEqual(["session:s1"]);
    expect(filterItems(ALL, { status: "running" })).toHaveLength(0);
  });

  it("工作区筛选：null 指未绑定工作区的会话", () => {
    expect(filterItems(ALL, { workspaceId: "w-1" }).map((entry) => entry.id)).toEqual(["session:s1"]);
    expect(filterItems(ALL, { workspaceId: null })).toHaveLength(0);
    // 不传 = 不过滤
    expect(filterItems(ALL, {})).toHaveLength(3);
  });
});

describe("searchItems", () => {
  it("空查询保持入参顺序（不排序，交给筛选条）", () => {
    expect(searchItems(ALL, "").map((entry) => entry.id)).toEqual(["session:s1", "nav:/team", "settings:mcp"]);
  });

  it("有关键词时按分数降序，同分保持原序", () => {
    const a = item({ id: "a", label: "计划 A", kind: "nav" });
    const b = item({ id: "b", label: "制定计划", kind: "nav" });
    const c = item({ id: "c", label: "无关", kind: "nav", description: "计划" });
    expect(searchItems([b, c, a], "计划").map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("检索与筛选叠加", () => {
    expect(searchItems(ALL, "团队", { type: "session" })).toHaveLength(0);
    expect(searchItems(ALL, "团队", { type: "feature" }).map((entry) => entry.id)).toEqual(["nav:/team"]);
  });
});

describe("sessionKeywords", () => {
  it("取最近若干条正文拼接，并截断超长语料", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({ content: `msg-${index}` }));
    const keywords = sessionKeywords(messages);
    expect(keywords).toContain("msg-19");
    expect(keywords).not.toContain("msg-0\n");
  });

  it("超长语料按字符上限截断", () => {
    const keywords = sessionKeywords([{ content: "x".repeat(5000) }]);
    expect(keywords.length).toBe(2000);
  });
});

describe("buildSearchItems", () => {
  it("会话在前、功能在后，会话带状态与正文关键词", () => {
    const items = buildSearchItems({
      sessions: [{ id: "s1", title: "会话一", workspaceId: "w-1", messages: [{ content: "提到 认证模块" }] }],
      navItems: [{ path: "/team", label: "团队" }],
      settingsSections: [{ key: "mcp", title: "MCP", description: "外部工具服务器" }],
      statusOf: () => "waiting",
    });
    expect(items.map((entry) => entry.kind)).toEqual(["session", "nav", "settings"]);
    expect(items[0]).toMatchObject({ label: "会话一", path: "/conversation/s1", status: "waiting", workspaceId: "w-1" });
    expect(items[0]?.keywords).toContain("认证模块");
    expect(items[1]).toMatchObject({ path: "/team", label: "团队" });
    expect(items[2]).toMatchObject({ section: "mcp", description: "外部工具服务器" });
  });

  it("会话正文能命中检索（标题不含关键词也能搜到）", () => {
    const items = buildSearchItems({
      sessions: [{ id: "s1", title: "会议记录", workspaceId: null, messages: [{ content: "讨论了 限流方案" }] }],
      navItems: [],
      settingsSections: [],
      statusOf: () => "done",
    });
    expect(searchItems(items, "限流").map((entry) => entry.id)).toEqual(["session:s1"]);
  });
});
