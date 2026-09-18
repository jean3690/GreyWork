/**
 * unified diff 解析：行号推进与「+++/--- 不能当成增删行」是这套解析最容易错的两点，
 * 错了表现为整个文件头被染成一行新增，且后续行号全偏。
 */
import { describe, expect, it } from "vitest";
import { countDiffLines, diffTexts, parseUnifiedDiff } from "@/lib/unified-diff";

const SINGLE = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,3 +10,4 @@",
  " const keep = 1;",
  "-const gone = 2;",
  "+const added = 2;",
  "+const more = 3;",
  " const tail = 4;",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("空输入返回空数组", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("   \n  ")).toEqual([]);
  });

  it("单文件 patch：路径取 b/ 侧，增删计数正确", () => {
    const files = parseUnifiedDiff(SINGLE);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/a.ts");
    expect(files[0].added).toBe(2);
    expect(files[0].removed).toBe(1);
  });

  it("+++ / --- 归 meta，不被当成增删行", () => {
    const files = parseUnifiedDiff(SINGLE);
    const kinds = files[0].lines.filter((line) => line.text.includes("src/a.ts")).map((line) => line.kind);
    // header（diff --git）+ 两条 meta，没有 add/del
    expect(kinds).not.toContain("add");
    expect(kinds).not.toContain("del");
    expect(kinds).toContain("meta");
  });

  it("行号按 @@ 头初始化并逐行推进：+ 只推 new，- 只推 old，上下文两边都推", () => {
    const files = parseUnifiedDiff(SINGLE);
    const body = files[0].lines.filter((line) => line.kind === "context" || line.kind === "add" || line.kind === "del");
    expect(body.map((line) => [line.kind, line.oldNo, line.newNo])).toEqual([
      ["context", 10, 10],
      ["del", 11, null],
      ["add", null, 11],
      ["add", null, 12],
      ["context", 12, 13],
    ]);
  });

  it("多文件 patch 被正确切段", () => {
    const patch = [
      SINGLE,
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1,1 +1,2 @@",
      " first",
      "+second",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    expect(files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files[1].added).toBe(1);
    expect(files[1].removed).toBe(0);
  });

  it("没有 diff --git 的裸 patch 用 +++ 起段，路径仍可用", () => {
    const bare = ["--- old.txt", "+++ new.txt", "@@ -1,1 +1,1 @@", "-a", "+b"].join("\n");
    const files = parseUnifiedDiff(bare);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("new.txt");
    expect(files[0].added).toBe(1);
    expect(files[0].removed).toBe(1);
  });

  it("没有 hunk 头的内容不崩，行号从 0 起（不假装知道位置）", () => {
    const files = parseUnifiedDiff(["diff --git a/x b/x", "+only"].join("\n"));
    expect(files).toHaveLength(1);
    expect(files[0].added).toBe(1);
    expect(files[0].lines.at(-1)?.newNo).toBe(0);
  });

  it("`\\ No newline at end of file` 归 meta", () => {
    const files = parseUnifiedDiff(["diff --git a/x b/x", "@@ -1 +1 @@", "-a", "+b", "\\ No newline at end of file"].join("\n"));
    expect(files[0].lines.at(-1)?.kind).toBe("meta");
  });

  it("CRLF patch：路径与行内容都不带尾随 \\r", () => {
    const files = parseUnifiedDiff(["diff --git a/src/a.ts b/src/a.ts", "@@ -1 +1 @@", "-old", "+new"].join("\r\n"));
    expect(files[0].path).toBe("src/a.ts");
    expect(files[0].lines.map((line) => line.text)).toEqual(["diff --git a/src/a.ts b/src/a.ts", "@@ -1 +1 @@", "old", "new"]);
  });
});

describe("countDiffLines", () => {
  it("跨文件累加行数（供超大 patch 截断判断）", () => {
    const files = parseUnifiedDiff(SINGLE);
    expect(countDiffLines(files)).toBe(files[0].lines.length);
  });
});

describe("diffTexts", () => {
  it("空输入返回空结果", () => {
    expect(diffTexts("", "")).toEqual({ lines: [], added: 0, removed: 0 });
  });

  it("oldText 为 null（整文件写入）：全部按新增，带新侧行号", () => {
    const result = diffTexts(null, "a\nb");
    expect(result.added).toBe(2);
    expect(result.removed).toBe(0);
    expect(result.lines.map((line) => [line.kind, line.oldNo, line.newNo, line.text])).toEqual([
      ["add", null, 1, "a"],
      ["add", null, 2, "b"],
    ]);
  });

  it("中间改一行：只标该行的增删，未变行按上下文保留", () => {
    const result = diffTexts("keep\nold\ntail", "keep\nnew\ntail");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.lines.map((line) => line.kind)).toEqual(["context", "del", "add", "context"]);
    expect(result.lines.map((line) => [line.oldNo, line.newNo])).toEqual([
      [1, 1],
      [2, null],
      [null, 2],
      [3, 3],
    ]);
  });

  it("纯新增：旧文是前缀，只在尾部补增", () => {
    const result = diffTexts("a\nb", "a\nb\nc");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.lines.at(-1)).toEqual({ kind: "add", text: "c", oldNo: null, newNo: 3 });
  });

  it("两侧行尾不同（CRLF vs LF）不算改动", () => {
    // Windows 上 agent 读回 CRLF 文件、写回 LF 是常态：不归一就会整篇判成改动。
    const result = diffTexts("keep\r\nsame\r\n", "keep\nsame\n");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.lines.every((line) => line.kind === "context")).toBe(true);
    expect(result.lines.map((line) => line.text)).toEqual(["keep", "same"]);
  });

  it("纯删除：新文是前缀，只在尾部删减", () => {
    const result = diffTexts("a\nb\nc", "a\nb");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(1);
    expect(result.lines.at(-1)).toEqual({ kind: "del", text: "c", oldNo: 3, newNo: null });
  });

  it("结尾换行不会凭空多出一条空行的改动", () => {
    const result = diffTexts("a\n", "a\n");
    expect(result).toEqual({ lines: [{ kind: "context", text: "a", oldNo: 1, newNo: 1 }], added: 0, removed: 0 });
  });

  it("行号连续推进：改一处后后续上下文行两侧行号都跟着走", () => {
    const result = diffTexts("a\nb\nc\nd", "a\nX\nc\nd");
    const body = result.lines.filter((line) => line.kind !== "context");
    expect(body).toEqual([
      { kind: "del", text: "b", oldNo: 2, newNo: null },
      { kind: "add", text: "X", oldNo: null, newNo: 2 },
    ]);
    expect(result.lines.at(-1)).toEqual({ kind: "context", text: "d", oldNo: 4, newNo: 4 });
  });

  it("超大输入走退化路径（不做 O(n·m) 对齐），仍给出正确增删计数", () => {
    const big = Array.from({ length: 3000 }, (_, index) => `line-${index}`).join("\n");
    const result = diffTexts(big, big);
    // 退化路径：旧文全删 + 新文全增
    expect(result.added).toBe(3000);
    expect(result.removed).toBe(3000);
  });
});
