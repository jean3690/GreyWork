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
});
