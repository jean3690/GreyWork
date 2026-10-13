import { describe, expect, it } from "vitest";
import { groupSessions } from "@/lib/grouped";

const workspaces = [
  { id: "p-gw-main", name: "GreyWork 主仓" },
  { id: "p-city", name: "城市数据洞察" },
  { id: "p-general", name: "普通对话" },
];

function session(id: string, title: string, workspaceId: string | null, updatedAt: number) {
  return { id, title, updatedAt, workspaceId };
}

describe("groupSessions 分组逻辑", () => {
  it("无关键字时每个工作区都出一行（含 0 会话），兜底行置底", () => {
    const groups = groupSessions({ workspaces, sessions: [] });
    expect(groups.map((g) => g.name)).toEqual(["GreyWork 主仓", "城市数据洞察", "普通对话"]);
    expect(groups.every((g) => g.sessions.length === 0)).toBe(true);
    expect(groups.map((g) => g.general)).toEqual([false, false, true]);
  });

  it("按工作区分组，空工作区仍在列表里", () => {
    const groups = groupSessions({
      workspaces,
      sessions: [session("a", "A 任务", "p-gw-main", 100)],
    });
    expect(groups.map((g) => [g.name, g.sessions.length])).toEqual([
      ["GreyWork 主仓", 1],
      ["城市数据洞察", 0],
      ["普通对话", 0],
    ]);
  });

  it("p-general 与未绑定会话合为一组并置底，组内按 updatedAt 倒序", () => {
    const groups = groupSessions({
      workspaces,
      sessions: [session("a", "A 任务", "p-gw-main", 100), session("b", "B 任务", "p-general", 300), session("c", "C 任务", null, 200)],
    });
    expect(groups).toHaveLength(3);
    const general = groups[2];
    expect(general?.id).toBe("p-general");
    expect(general?.name).toBe("普通对话");
    expect(general?.general).toBe(true);
    expect(general?.sessions.map((s) => s.id)).toEqual(["b", "c"]);
  });

  it("组内按 updatedAt 倒序", () => {
    const groups = groupSessions({
      workspaces,
      sessions: [
        session("a", "A 任务", "p-gw-main", 100),
        session("b", "B 任务", "p-gw-main", 300),
        session("c", "C 任务", "p-gw-main", 200),
      ],
    });
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("keyword 过滤标题（大小写不敏感），无命中的组整行隐去", () => {
    const groups = groupSessions({
      workspaces,
      sessions: [session("a", "修复 Bug", "p-gw-main", 100), session("b", "写周报", "p-gw-main", 200), session("c", "闲聊", null, 300)],
      keyword: "bug",
    });
    expect(groups.map((g) => g.name)).toEqual(["GreyWork 主仓"]);
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["a"]);
  });

  it("无 p-general 时未绑定会话归到「未分组」", () => {
    const groups = groupSessions({
      workspaces: workspaces.filter((w) => w.id !== "p-general"),
      sessions: [session("a", "A 任务", null, 100)],
    });
    const general = groups.at(-1);
    expect(general?.name).toBe("未分组");
    expect(general?.id).toBe(null);
    expect(general?.sessions.map((s) => s.id)).toEqual(["a"]);
  });

  it("全部组被 keyword 过滤空时返回空", () => {
    const groups = groupSessions({
      workspaces,
      sessions: [session("a", "修复 Bug", "p-gw-main", 100)],
      keyword: "不存在",
    });
    expect(groups).toEqual([]);
  });

  it("excludeIds 里的会话从分组中摘除（协作成员位会话不在常规列表重复出现）", () => {
    const groups = groupSessions({
      workspaces,
      sessions: [
        session("keep", "普通会话", "p-gw-main", 100),
        session("slot-1", "Builder · 目标", "p-gw-main", 200),
        session("slot-2", "Reviewer · 目标", "p-gw-main", 300),
      ],
      excludeIds: new Set(["slot-1", "slot-2"]),
    });
    // 计数也只算留下的：主仓组只剩 keep 一条。
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["keep"]);
  });

  it("excludeIds 先于 keyword 生效：被排除的会话即使命中关键字也不出现", () => {
    const groups = groupSessions({
      workspaces,
      sessions: [session("slot-1", "Builder · 目标", "p-gw-main", 100)],
      keyword: "builder",
      excludeIds: new Set(["slot-1"]),
    });
    // 主仓组被过滤空 → 整行隐去（搜索态）；只剩兜底行被 keyword 抑制 → 空
    expect(groups).toEqual([]);
  });
});

describe("groupSessions 排序档", () => {
  const rows = [
    session("a", "banana", "p-gw-main", 100),
    session("b", "apple", "p-gw-main", 300),
    session("c", "cherry", "p-gw-main", 200),
  ];

  it("缺省（recent）：组内按 updatedAt 倒序", () => {
    const groups = groupSessions({ workspaces, sessions: rows });
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("title：组内按标题 A→Z（localeCompare 走语言相关排序）", () => {
    const groups = groupSessions({ workspaces, sessions: rows, sort: "title" });
    expect(groups[0]?.sessions.map((s) => s.title)).toEqual(["apple", "banana", "cherry"]);
  });

  it("title：兜底行（p-general + 未绑定）合并后也按标题排", () => {
    const groups = groupSessions({
      workspaces,
      sessions: [session("x", "zebra", null, 300), session("y", "ant", "p-general", 100)],
      sort: "title",
    });
    const general = groups.find((g) => g.general);
    expect(general?.sessions.map((s) => s.title)).toEqual(["ant", "zebra"]);
  });
});
