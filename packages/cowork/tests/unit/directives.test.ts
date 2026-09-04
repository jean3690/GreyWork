import { describe, expect, it } from "vitest";
import { parseDirectives } from "../../src/directives";

describe("parseDirectives", () => {
  it("解析单条指令与指令数组", () => {
    const single = parseDirectives('```cowork\n{"op":"message","to":"reviewer","body":"看一下"}\n```');
    expect(single).toEqual([{ op: "message", to: "reviewer", body: "看一下" }]);

    const many = parseDirectives(
      '好的。\n```cowork\n[{"op":"task","subject":"实现登录","owner":"builder"},{"op":"task_update","taskId":"ct-1","status":"done","result":"完成"}]\n```\n就这样。',
    );
    expect(many).toEqual([
      { op: "task", subject: "实现登录", owner: "builder" },
      { op: "task_update", taskId: "ct-1", status: "done", result: "完成" },
    ]);
  });

  it("合并多个围栏，跳过坏 JSON", () => {
    const directives = parseDirectives(
      '```cowork\n{"op":"message","to":"a","body":"一"}\n```\n```cowork\n{坏 JSON\n```\n```cowork\n{"op":"message","to":"b","body":"二"}\n```',
    );
    expect(directives.map((item) => (item.op === "message" ? item.to : item.op))).toEqual(["a", "b"]);
  });

  it("跳过字段不合法的条目", () => {
    const directives = parseDirectives(
      '```cowork\n[{"op":"message","to":"","body":"缺收件人"},{"op":"message","to":"a","body":""},{"op":"task"},{"op":"task_update","taskId":"ct-1"},{"op":"未知","x":1},{"op":"task_update","taskId":"ct-2","status":"胡说"}]\n```',
    );
    expect(directives).toEqual([]);
  });

  it("不吃无 cowork 标签的普通代码块，避免把示例代码当指令执行", () => {
    const directives = parseDirectives('```json\n{"op":"message","to":"a","body":"示例"}\n```');
    expect(directives).toEqual([]);
  });

  it("blockedBy 过滤空串，缺省字段不落进结果", () => {
    const directives = parseDirectives('```cowork\n{"op":"task","subject":"评审","blockedBy":["ct-1","",null]}\n```');
    expect(directives).toEqual([{ op: "task", subject: "评审", blockedBy: ["ct-1"] }]);
  });

  it("只带 result 的 task_update 有效，空操作被丢弃", () => {
    expect(parseDirectives('```cowork\n{"op":"task_update","taskId":"ct-1","result":"结论"}\n```')).toEqual([
      { op: "task_update", taskId: "ct-1", result: "结论" },
    ]);
    expect(parseDirectives('```cowork\n{"op":"task_update","taskId":"ct-1"}\n```')).toEqual([]);
  });

  it("没有围栏时返回空数组", () => {
    expect(parseDirectives("我先想一下这件事怎么做。")).toEqual([]);
    expect(parseDirectives("")).toEqual([]);
  });
});
