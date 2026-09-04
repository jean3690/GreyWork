import { describe, expect, it } from "vitest";
import { isSafeHref, parseBlocks, parseInline, type Block } from "@/lib/markdown";

/** 取首个指定类型的块，断言存在。 */
function firstOf<T extends Block["type"]>(blocks: Block[], type: T): Extract<Block, { type: T }> {
  const found = blocks.find((b) => b.type === type);
  expect(found, `未解析出 ${type} 块`).toBeTruthy();
  return found as Extract<Block, { type: T }>;
}

/** 把 inline token 摊平成纯文本，便于断言内容而不纠结 token 结构。 */
function flat(tokens: { t: string; v: string }[]): string {
  return tokens.map((token) => token.v).join("");
}

describe("parseInline", () => {
  it("识别 code / bold / italic / strike", () => {
    const tokens = parseInline("普通 `code` 与 **粗** 与 *斜* 与 ~~删~~");
    expect(tokens.filter((t) => t.t === "code")).toHaveLength(1);
    expect(tokens.filter((t) => t.t === "bold")).toHaveLength(1);
    expect(tokens.filter((t) => t.t === "italic")).toHaveLength(1);
    expect(tokens.filter((t) => t.t === "strike")).toHaveLength(1);
  });

  it("粗体优先于斜体，**x** 不被切成斜体", () => {
    const tokens = parseInline("**bold**");
    expect(tokens).toEqual([{ t: "bold", v: "bold" }]);
  });

  it("snake_case 不被误判为斜体", () => {
    const tokens = parseInline("use_some_name here");
    expect(tokens).toEqual([{ t: "text", v: "use_some_name here" }]);
  });

  it("反引号内的标记不再二次解析", () => {
    const tokens = parseInline("`**not bold**`");
    expect(tokens).toEqual([{ t: "code", v: "**not bold**" }]);
  });

  it("安全链接渲染为 link，危险协议降级为文本", () => {
    expect(parseInline("[a](https://example.com)")).toEqual([{ t: "link", v: "a", href: "https://example.com" }]);
    expect(parseInline("[a](./docs/b.md)")).toEqual([{ t: "link", v: "a", href: "./docs/b.md" }]);
    // href 内含 ( ) 时正则只吃到首个右括号，尾巴留作文本；关键是不产出 link token
    const danger = parseInline("[x](javascript:alert(1))");
    expect(danger.some((token) => token.t === "link")).toBe(false);
    expect(flat(danger)).toBe("[x](javascript:alert(1))");
  });
});

describe("isSafeHref", () => {
  it("放行白名单协议与相对路径", () => {
    expect(isSafeHref("https://a.com")).toBe(true);
    expect(isSafeHref("http://a.com")).toBe(true);
    expect(isSafeHref("mailto:a@b.com")).toBe(true);
    expect(isSafeHref("#anchor")).toBe(true);
    expect(isSafeHref("/abs/path")).toBe(true);
    expect(isSafeHref("docs/rel.md")).toBe(true);
  });

  it("拦截脚本类协议，含控制字符绕过", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,<script>")).toBe(false);
    expect(isSafeHref("vbscript:msgbox")).toBe(false);
    expect(isSafeHref("java\nscript:alert(1)")).toBe(false);
    expect(isSafeHref("")).toBe(false);
  });
});

describe("parseBlocks · 标题", () => {
  it("# 到 ###### 解析为对应层级，而非普通段落", () => {
    const blocks = parseBlocks("# H1\n## H2\n###### H6");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "heading", "heading"]);
    expect(blocks.map((b) => (b.type === "heading" ? b.level : 0))).toEqual([1, 2, 6]);
    expect(flat(firstOf(blocks, "heading").inline)).toBe("H1");
  });

  it("七个 # 不再是标题", () => {
    expect(parseBlocks("####### too deep")[0].type).toBe("p");
  });

  it("# 后无空格不算标题（规避 #tag）", () => {
    expect(parseBlocks("#hashtag")[0].type).toBe("p");
  });
});

describe("parseBlocks · 列表", () => {
  it("无序列表按缩进折成嵌套树", () => {
    const list = firstOf(parseBlocks("- a\n- b\n  - b1\n  - b2\n- c"), "list");
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(3);
    expect(list.items[1].children?.items.map((child) => flat(child.inline))).toEqual(["b1", "b2"]);
    expect(list.items[0].children).toBeNull();
  });

  it("有序列表保留起始序号", () => {
    const list = firstOf(parseBlocks("3. three\n4. four"), "list");
    expect(list.ordered).toBe(true);
    expect(list.start).toBe(3);
    expect(list.items).toHaveLength(2);
  });

  it("同层有序/无序交界处切分为两个块", () => {
    const blocks = parseBlocks("- a\n1. b");
    expect(blocks.map((b) => b.type)).toEqual(["list", "list"]);
    expect(blocks.map((b) => (b.type === "list" ? b.ordered : null))).toEqual([false, true]);
  });

  it("有序项下可嵌无序子表（逐层独立判定有序性）", () => {
    const blocks = parseBlocks("1. step\n   - detail A\n   - detail B\n2. next");
    expect(blocks).toHaveLength(1);
    const list = firstOf(blocks, "list");
    expect(list.ordered).toBe(true);
    expect(list.items.map((item) => flat(item.inline))).toEqual(["step", "next"]);
    const sub = list.items[0].children;
    expect(sub?.ordered).toBe(false);
    expect(sub?.items.map((item) => flat(item.inline))).toEqual(["detail A", "detail B"]);
  });

  it("缩进回退能正确出栈到上层", () => {
    const list = firstOf(parseBlocks("- a\n  - a1\n    - a2\n- b"), "list");
    expect(list.items.map((item) => flat(item.inline))).toEqual(["a", "b"]);
    expect(flat(list.items[0].children!.items[0].children!.items[0].inline)).toBe("a2");
  });

  it("tab 缩进等价 4 空格", () => {
    const list = firstOf(parseBlocks("- a\n\t- a1"), "list");
    expect(list.items).toHaveLength(1);
    expect(list.items[0].children?.items.map((item) => flat(item.inline))).toEqual(["a1"]);
  });
});

describe("parseBlocks · 表格", () => {
  it("表头 + 对齐行 + 数据行", () => {
    const table = firstOf(parseBlocks("| a | b |\n| :-- | --: |\n| 1 | 2 |\n| 3 | 4 |"), "table");
    expect(table.headers.map(flat)).toEqual(["a", "b"]);
    expect(table.align).toEqual(["left", "right"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1].map(flat)).toEqual(["3", "4"]);
  });

  it("居中对齐 :-: 与无对齐 ---", () => {
    const table = firstOf(parseBlocks("| a | b |\n| :-: | --- |\n| 1 | 2 |"), "table");
    expect(table.align).toEqual(["center", null]);
  });

  it("缺对齐行时退回段落，不误判为表格", () => {
    const blocks = parseBlocks("| a | b |\n| 1 | 2 |");
    expect(blocks.every((b) => b.type === "p")).toBe(true);
  });
});

describe("parseBlocks · 代码块", () => {
  it("围栏保留原文，路径型 caption 记为 path", () => {
    const code = firstOf(parseBlocks("```ts src/main.ts\nconst a = 1;\n# not heading\n```"), "code");
    expect(code.lang).toBe("ts");
    expect(code.path).toBe("src/main.ts");
    expect(code.codeLines).toEqual(["const a = 1;", "# not heading"]);
  });

  it("非路径 caption 不当 path", () => {
    expect(firstOf(parseBlocks("```ts\nx\n```"), "code").path).toBeUndefined();
  });

  it("未闭合围栏吃到文末（流式半截输出）", () => {
    const code = firstOf(parseBlocks("```\nline1\nline2"), "code");
    expect(code.codeLines).toEqual(["line1", "line2"]);
  });
});

describe("parseBlocks · 引用与分割线", () => {
  it("连续 > 合并为一个引用块", () => {
    const quote = firstOf(parseBlocks("> l1\n> l2\n\nafter"), "quote");
    expect(quote.lines.map(flat)).toEqual(["l1", "l2"]);
  });

  it("--- / *** / ___ 均为分割线", () => {
    expect(parseBlocks("---\n***\n___").map((b) => b.type)).toEqual(["hr", "hr", "hr"]);
  });
});

describe("parseBlocks · 段落", () => {
  it("连续行并入同一段落并保留换行", () => {
    const para = firstOf(parseBlocks("line1\nline2\n\nline3"), "p");
    expect(para.lines).toHaveLength(2);
    expect(para.lines.map(flat)).toEqual(["line1", "line2"]);
  });

  it("段落遇标题即止", () => {
    expect(parseBlocks("text\n# H").map((b) => b.type)).toEqual(["p", "heading"]);
  });

  it("段落遇表格即止", () => {
    expect(parseBlocks("text\n| a |\n| --- |\n| 1 |").map((b) => b.type)).toEqual(["p", "table"]);
  });

  it("空输入产出空数组，纯空行不产生空段落", () => {
    expect(parseBlocks("")).toEqual([]);
    expect(parseBlocks("\n\n  \n")).toEqual([]);
  });
});

describe("parseBlocks · 演示 Brief 端到端", () => {
  // 回归动图里那份文档：此前手写解析器把 # 当纯文本，整份 Brief 渲染成一坨段落
  const brief = [
    "# Solar System Journey - Presentation Brief",
    "",
    "## Section 1: Summary",
    "",
    "Topic: A Journey Through the Solar System",
    "Audience: General audience",
    "",
    "## Section 2: Outline",
    "",
    "1. The Solar System",
    "2. The Heart of It All: The Sun",
    "",
    "## Section 3: Page Briefs",
    "",
    "- S1 (Intro)",
    "  - Objective: Introduce the presentation",
    "  - Core innovation: adaptive",
  ].join("\n");

  it("标题 / 段落 / 有序表 / 嵌套无序表各就各位", () => {
    const blocks = parseBlocks(brief);
    expect(blocks.map((b) => b.type)).toEqual(["heading", "heading", "p", "heading", "list", "heading", "list"]);
    const headings = blocks.filter((b) => b.type === "heading");
    expect(headings.map((b) => (b.type === "heading" ? b.level : 0))).toEqual([1, 2, 2, 2]);
    const lists = blocks.filter((b) => b.type === "list");
    expect(lists[0].type === "list" && lists[0].ordered).toBe(true);
    expect(lists[1].type === "list" && lists[1].items[0].children?.items).toHaveLength(2);
  });
});
