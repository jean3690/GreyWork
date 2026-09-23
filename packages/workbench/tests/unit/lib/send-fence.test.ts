/**
 * ```sendfile 围栏解析：远程助手「把文件发给对方」的唯一入口。
 * 半份指令（坏 JSON / 相对路径）必须整条丢弃 —— 相对路径宿主无从解析，
 * 它会按自己的 cwd 猜，猜错就是把错的文件发出去。
 */
import { describe, expect, it } from "vitest";

import { parseSendFences, stripSendFences } from "@/lib/send-fence";

describe("parseSendFences", () => {
  it("解析数组围栏，按出现顺序返回绝对路径", () => {
    const output = ["文件给你。", "```sendfile", JSON.stringify(["/home/u/report.xlsx", "/home/u/notes.pdf"]), "```"].join("\n");
    expect(parseSendFences(output)).toEqual(["/home/u/report.xlsx", "/home/u/notes.pdf"]);
  });

  it("接受单个字符串形式的围栏", () => {
    const output = `\`\`\`sendfile\n${JSON.stringify("/home/u/a.md")}\n\`\`\``;
    expect(parseSendFences(output)).toEqual(["/home/u/a.md"]);
  });

  it("多个围栏合并，重复路径只留一份", () => {
    const fence = (value: unknown): string => `\`\`\`sendfile\n${JSON.stringify(value)}\n\`\`\``;
    const output = [fence(["/home/u/a.md"]), fence(["/home/u/a.md", "/home/u/b.md"])].join("\n");
    expect(parseSendFences(output)).toEqual(["/home/u/a.md", "/home/u/b.md"]);
  });

  it("坏 JSON / 非字符串元素 / 相对路径整条丢弃，不影响其它条目", () => {
    const output = [
      "```sendfile\n{not json\n```",
      `\`\`\`sendfile\n${JSON.stringify(["report.xlsx", "", "  ", 42, "/home/u/ok.pdf"])}\n\`\`\``,
    ].join("\n");
    expect(parseSendFences(output)).toEqual(["/home/u/ok.pdf"]);
  });

  it("Windows 盘符绝对路径也认（反斜杠与正斜杠两种写法）", () => {
    // 围栏正文是 JSON：反斜杠要写成 `\\`，JS 源码里再各转义一层。
    const output = "```sendfile\n" + '["C:\\\\Users\\\\u\\\\a.xlsx","C:/Users/u/b.xlsx"]' + "\n```";
    expect(parseSendFences(output)).toEqual(["C:\\Users\\u\\a.xlsx", "C:/Users/u/b.xlsx"]);
  });

  it("不带 sendfile 标签的代码块 / 裸文本不认", () => {
    const output = [`\`\`\`json\n${JSON.stringify(["/home/u/a.md"])}\n\`\`\``, "顺手提一句 /home/u/b.md 这个文件"].join("\n");
    expect(parseSendFences(output)).toEqual([]);
  });
});

describe("stripSendFences", () => {
  it("剥掉围栏并修剪首尾空白", () => {
    const output = ["文件给你。", "```sendfile", JSON.stringify(["/home/u/a.md"]), "```", ""].join("\n");
    expect(stripSendFences(output)).toBe("文件给你。");
  });

  it("没有围栏时原样（仅 trim）", () => {
    expect(stripSendFences("  就一段话  ")).toBe("就一段话");
  });
});
