/**
 * ```schedule 围栏解析：这是「AI 提议定时任务」的唯一入口，坏 JSON / 半份提案
 * 都必须整条丢弃 —— 确认卡上出现一个永远不触发的任务比没有提案更糟。
 */
import { describe, expect, it } from "vitest";

import { parseScheduleFences } from "@/lib/schedule-fence";

const FUTURE = Date.now() + 60 * 60 * 1000;

describe("parseScheduleFences", () => {
  it("解析标准 cron 围栏与一次性任务围栏", () => {
    const output = [
      "前言",
      "```schedule",
      JSON.stringify({ name: "站会提醒", intent: "发起站会", cron: "0 9 * * *" }),
      "```",
      "```schedule",
      JSON.stringify({ name: "备份", intent: "跑一次备份", onceAt: FUTURE }),
      "```",
    ].join("\n");
    const fences = parseScheduleFences(output);
    expect(fences).toEqual([
      { name: "站会提醒", intent: "发起站会", cron: "0 9 * * *" },
      { name: "备份", intent: "跑一次备份", onceAt: FUTURE },
    ]);
  });

  it("接受单对象或数组形式", () => {
    const arrayFence = `\`\`\`schedule\n${JSON.stringify([
      { name: "a", intent: "ia", cron: "@daily" },
      { name: "b", intent: "ib", cron: "0 9 * * *" },
    ])}\n\`\`\``;
    expect(parseScheduleFences(arrayFence)).toHaveLength(2);
  });

  it("坏 JSON 整块丢弃，不影响其它围栏", () => {
    const output = [
      "```schedule\n{not json\n```",
      `\`\`\`schedule\n${JSON.stringify({ name: "ok", intent: "i", cron: "0 9 * * *" })}\n\`\`\``,
    ].join("\n");
    expect(parseScheduleFences(output)).toHaveLength(1);
  });

  it("缺 name / intent、无有效触发条件的条目整条丢弃", () => {
    const base = (entry: Record<string, unknown>): string => `\`\`\`schedule\n${JSON.stringify(entry)}\n\`\`\``;
    expect(parseScheduleFences(base({ intent: "i", cron: "0 9 * * *" }))).toHaveLength(0);
    expect(parseScheduleFences(base({ name: "n", cron: "0 9 * * *" }))).toHaveLength(0);
    // 既无 cron 又无 onceAt
    expect(parseScheduleFences(base({ name: "n", intent: "i" }))).toHaveLength(0);
    // cron 非法
    expect(parseScheduleFences(base({ name: "n", intent: "i", cron: "99 99 * *" }))).toHaveLength(0);
    // onceAt 已过去
    expect(parseScheduleFences(base({ name: "n", intent: "i", onceAt: Date.now() - 1000 }))).toHaveLength(0);
  });

  it("非法的 cron/onceAt 字段被丢弃，但带另一个合法触发条件的条目保留", () => {
    const fence = `\`\`\`schedule\n${JSON.stringify({ name: "n", intent: "i", cron: "bad", onceAt: FUTURE })}\n\`\`\``;
    expect(parseScheduleFences(fence)).toEqual([{ name: "n", intent: "i", onceAt: FUTURE }]);
  });

  it("不带 schedule 标签的代码块不认（裸 JSON / 其它语言围栏）", () => {
    const output = `\`\`\`json\n${JSON.stringify({ name: "n", intent: "i", cron: "0 9 * * *" })}\n\`\`\``;
    expect(parseScheduleFences(output)).toHaveLength(0);
    expect(parseScheduleFences("纯文本，没有围栏")).toHaveLength(0);
  });
});
