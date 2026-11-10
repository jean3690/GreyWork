import { javascript } from "@codemirror/lang-javascript";
import { describe, expect, it } from "vitest";

import { guessCodeLanguage, highlightTextLines } from "@/lib/code-highlight";

const language = javascript().language;

describe("代码片段着色", () => {
  it("按行返回 HTML，保留空行占位", () => {
    const html = highlightTextLines("const a = 1;\n\nconst b = 2;", language);
    expect(html).toHaveLength(3);
    expect(html[0]).toContain("text-violet");
    expect(html[1]).toBe("");
    expect(html[2]).toContain("text-violet");
  });

  it("转义 HTML，避免片段注入", () => {
    const html = highlightTextLines('const s = "<img src=x onerror=alert(1)>";', language);
    expect(html[0]).toContain("&lt;img");
    expect(html[0]).not.toContain("<img");
  });

  it("语言推断：路径扩展名优先，其次嗅探 JSON", () => {
    expect(guessCodeLanguage("src/a.ts", "plain")).toBe("javascript");
    expect(guessCodeLanguage(undefined, '{"a":1}')).toBe("json");
    expect(guessCodeLanguage(undefined, "not json")).toBeNull();
    // 扩展名不认识时退到内容嗅探（.log 里也可能是 JSON）
    expect(guessCodeLanguage("a.log", '{"a":1}')).toBe("json");
  });
});
