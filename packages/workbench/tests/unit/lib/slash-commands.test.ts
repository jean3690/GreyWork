/**
 * 斜杠命令纯逻辑契约：触发边界、过滤、ACP 归一化、内置与 agent 目录合并。
 */

import { describe, expect, it } from "vitest";
import {
  BUILTIN_SLASH_COMMANDS,
  buildSlashItems,
  filterSlashCommands,
  matchSlashQuery,
  normalizeAcpCommands,
  slashOptionId,
  type SlashCommandItem,
} from "../../../src/lib/slash-commands";

const t = (key: string): string => `t:${key}`;

function acp(name: string, description = `${name} 描述`, hint?: string): { name: string; description: string; input?: { hint: string } } {
  return hint ? { name, description, input: { hint } } : { name, description };
}

describe("matchSlashQuery", () => {
  it("行首斜杠触发，查询串不含斜杠", () => {
    expect(matchSlashQuery("/")).toBe("");
    expect(matchSlashQuery("/pl")).toBe("pl");
    expect(matchSlashQuery("/PLAN")).toBe("PLAN");
  });

  it("已输入空格 / 不在行首 / 多行都不触发", () => {
    expect(matchSlashQuery("/a b")).toBeNull();
    expect(matchSlashQuery("hello /pl")).toBeNull();
    expect(matchSlashQuery("/pl\nmore")).toBeNull();
    expect(matchSlashQuery("")).toBeNull();
    expect(matchSlashQuery("pl")).toBeNull();
  });

  it("连续斜杠仍是查询串，由过滤层消化", () => {
    expect(matchSlashQuery("//")).toBe("/");
  });
});

describe("filterSlashCommands", () => {
  const items = buildSlashItems({ t, acpCommands: [], routeToAcp: false, planMode: false, speedBoost: false });

  it("空查询返回全部", () => {
    expect(filterSlashCommands(items, "")).toHaveLength(items.length);
    expect(filterSlashCommands(items, "/")).toHaveLength(items.length);
  });

  it("名称前缀匹配，大小写不敏感", () => {
    expect(filterSlashCommands(items, "pl").map((item) => item.name)).toEqual(["plan"]);
    expect(filterSlashCommands(items, "RE").map((item) => item.name)).toEqual(["report", "review"]);
  });

  it("无匹配返回空数组", () => {
    expect(filterSlashCommands(items, "zzz")).toEqual([]);
  });
});

describe("normalizeAcpCommands", () => {
  it("非数组输入返回空", () => {
    expect(normalizeAcpCommands(undefined)).toEqual([]);
    expect(normalizeAcpCommands("compact")).toEqual([]);
    expect(normalizeAcpCommands({ name: "compact" })).toEqual([]);
  });

  it("脏条目逐条丢弃，不整批报废", () => {
    const commands = normalizeAcpCommands([
      null,
      42,
      { name: "ok", description: "可用" },
      { name: "no-desc" },
      { description: "缺名" },
      { name: "has space", description: "名含空白" },
      { name: "   ", description: "空白名" },
    ]);
    expect(commands.map((command) => command.name)).toEqual(["ok"]);
  });

  it("至多剥一个前导斜杠并去重", () => {
    const commands = normalizeAcpCommands([
      { name: "/compact", description: "压缩上下文" },
      { name: "compact", description: "重复" },
      { name: "//weird", description: "多重斜杠" },
    ]);
    expect(commands.map((command) => command.name)).toEqual(["compact", "/weird"]);
  });

  it("保留合法 input.hint，畸形 input 视为无参", () => {
    const commands = normalizeAcpCommands([
      { name: "deploy", description: "部署", input: { hint: "环境名" } },
      { name: "plain", description: "无参", input: { hint: "   " } },
      { name: "broken", description: "坏 input", input: "env" },
    ]);
    expect(commands[0]).toEqual({ name: "deploy", description: "部署", input: { hint: "环境名" } });
    expect(commands[1]).toEqual({ name: "plain", description: "无参" });
    expect(commands[2]).toEqual({ name: "broken", description: "坏 input" });
  });
});

describe("buildSlashItems", () => {
  it("内置命令按清单顺序在前，描述走 i18n key", () => {
    const items = buildSlashItems({ t, acpCommands: [], routeToAcp: false, planMode: false, speedBoost: false });
    expect(items.map((item) => item.name)).toEqual(BUILTIN_SLASH_COMMANDS.map((command) => command.id));
    expect(items[0]?.description).toBe("t:chat.commands.plan.desc");
    expect(items[0]?.id).toBe("builtin:plan");
    expect(items.find((item) => item.name === "test")?.templateKey).toBe("chat.commands.test.template");
  });

  it("toggle 命令带当前开关状态，模板命令不带 active", () => {
    const items = buildSlashItems({ t, acpCommands: [], routeToAcp: false, planMode: true, speedBoost: false });
    const byName = new Map(items.map((item) => [item.name, item]));
    expect(byName.get("plan")?.active).toBe(true);
    expect(byName.get("speed")?.active).toBe(false);
    expect(byName.get("test")?.active).toBeUndefined();
  });

  it("未走 ACP 路由时不带 agent 命令", () => {
    const items = buildSlashItems({ t, acpCommands: [acp("compact")], routeToAcp: false, planMode: false, speedBoost: false });
    expect(items.some((item) => item.source === "acp")).toBe(false);
  });

  it("ACP 命令追加在内置之后，hint 决定 requiresInput", () => {
    const items = buildSlashItems({
      t,
      acpCommands: [acp("compact", "压缩上下文"), acp("deploy", "部署", "环境名")],
      routeToAcp: true,
      planMode: false,
      speedBoost: false,
    });
    const tail = items.slice(BUILTIN_SLASH_COMMANDS.length);
    expect(tail.map((item) => item.name)).toEqual(["compact", "deploy"]);
    expect(tail[0]).toMatchObject({ source: "acp", id: "acp:compact", description: "压缩上下文", requiresInput: false });
    expect(tail[1]).toMatchObject({ source: "acp", hint: "环境名", requiresInput: true });
    expect(tail[1]?.templateKey).toBeUndefined();
  });

  it("与内置同名时内置优先，不再出现 agent 条目", () => {
    const items = buildSlashItems({ t, acpCommands: [acp("plan", "agent 的 plan")], routeToAcp: true, planMode: false, speedBoost: false });
    expect(items.filter((item) => item.name === "plan")).toHaveLength(1);
    expect(items.find((item) => item.name === "plan")?.source).toBe("builtin");
  });
});

describe("slashOptionId", () => {
  it("产出稳定合法 id，冒号等非标识字符被压平", () => {
    const item: SlashCommandItem = {
      id: "acp:my.cmd",
      name: "my.cmd",
      description: "",
      source: "acp",
      requiresInput: false,
    };
    expect(slashOptionId(item)).toBe("slash-option-acp-my-cmd");
    expect(slashOptionId({ ...item, id: "builtin:plan" })).toBe("slash-option-builtin-plan");
  });
});
