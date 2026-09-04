/**
 * unified diff 解析：行号推进与「+++/--- 不能当成增删行」是这套解析最容易错的两点，
 * 错了表现为整个文件头被染成一行新增，且后续行号全偏。
 */
import { describe, expect, it } from "vitest";
import { countDiffLines, parseUnifiedDiff } from "@/lib/unified-diff";

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
});

describe("countDiffLines", () => {
  it("跨文件累加行数（供超大 patch 截断判断）", () => {
    const files = parseUnifiedDiff(SINGLE);
    expect(countDiffLines(files)).toBe(files[0].lines.length);
  });
});
