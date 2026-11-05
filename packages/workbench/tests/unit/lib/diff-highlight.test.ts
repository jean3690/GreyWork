import { javascript } from "@codemirror/lang-javascript";
import { describe, expect, it } from "vitest";

import { highlightDiffLines } from "@/lib/diff-highlight";
import type { DiffFile } from "@/lib/unified-diff";

const language = javascript().language;

function fileOf(lines: DiffFile["lines"]): DiffFile {
  return { path: "src/app.ts", lines, added: 0, removed: 0 };
}

describe("diff 语法高亮", () => {
  it("整侧解析后把 token 映射回各行；header / hunk 不着色", () => {
    const html = highlightDiffLines(
      fileOf([
        { kind: "header", text: "diff --git a/src/app.ts b/src/app.ts", oldNo: null, newNo: null },
        { kind: "hunk", text: "@@ -1,2 +1,2 @@", oldNo: null, newNo: null },
        { kind: "del", text: "const a = 1;", oldNo: 1, newNo: null },
        { kind: "add", text: 'const b = "x";', oldNo: null, newNo: 1 },
        { kind: "context", text: "// keep", oldNo: 2, newNo: 2 },
      ]),
      language,
    );
    expect(html[0]).toBeNull();
    expect(html[1]).toBeNull();
    expect(html[2]).toContain('class="text-violet"');
    expect(html[3]).toContain('class="text-mint"');
    expect(html[4]).toContain("text-dim2");
  });

  it("转义 HTML，避免 diff 文本注入", () => {
    const html = highlightDiffLines(
      fileOf([{ kind: "add", text: 'const s = "<img src=x onerror=alert(1)>";', oldNo: null, newNo: 1 }]),
      language,
    );
    expect(html[0]).toContain("&lt;img");
    expect(html[0]).not.toContain("<img");
  });

  it("空 diff / 空行退化为 null，不抛错", () => {
    expect(highlightDiffLines(fileOf([]), language)).toEqual([]);
    const html = highlightDiffLines(fileOf([{ kind: "add", text: "", oldNo: null, newNo: 1 }]), language);
    expect(html[0] ?? null).toBeNull();
  });
});
