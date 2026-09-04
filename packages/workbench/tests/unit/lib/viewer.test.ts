/**
 * 产物查看器分派：kind 判定是唯一的「按什么打开」决策点，二进制白名单更是
 * 防止 xlsx 被当文本读坏的护栏 —— 两者都必须有用例守住。
 */
import { describe, expect, it } from "vitest";
import { basename, codeLanguageOfPath, isBinaryKind, kindOfPath, type ViewerKind } from "@/lib/viewer";

describe("kindOfPath", () => {
  it.each<[string, ViewerKind]>([
    ["reports/a.md", "md"],
    ["notes.markdown", "md"],
    ["page.html", "html"],
    ["page.htm", "html"],
    ["data/stations.csv", "csv"],
    ["src/index.ts", "code"],
    ["config.json", "code"],
    ["book.xlsx", "xlsx"],
    ["legacy.xls", "xlsx"],
    ["brief.docx", "docx"],
    ["deck.pptx", "pptx"],
    ["manual.pdf", "pdf"],
    ["fix.diff", "diff"],
    ["fix.patch", "diff"],
    ["logo.png", "image"],
    ["logo.svg", "image"],
  ])("%s → %s", (path, kind) => {
    expect(kindOfPath(path)).toBe(kind);
  });

  it("扩展名大小写不敏感", () => {
    expect(kindOfPath("REPORT.MD")).toBe("md");
    expect(kindOfPath("Book.XLSX")).toBe("xlsx");
  });

  it("无扩展名与未知扩展名都归 raw（永远不会打不开）", () => {
    expect(kindOfPath("Makefile")).toBe("raw");
    expect(kindOfPath("archive.tar.zst")).toBe("raw");
    expect(kindOfPath("")).toBe("raw");
  });
});

describe("isBinaryKind", () => {
  it.each<ViewerKind>(["xlsx", "docx", "pptx", "pdf", "image"])("%s 必须按二进制读", (kind) => {
    expect(isBinaryKind(kind)).toBe(true);
  });

  it.each<ViewerKind>(["md", "html", "csv", "code", "diff", "raw"])("%s 按文本读", (kind) => {
    expect(isBinaryKind(kind)).toBe(false);
  });
});

describe("basename", () => {
  it("取末段；无斜杠时原样返回", () => {
    expect(basename("reports/2026/a.md")).toBe("a.md");
    expect(basename("a.md")).toBe("a.md");
  });

  it("以斜杠结尾时返回空串（调用方自己决定要不要兜底）", () => {
    expect(basename("reports/")).toBe("");
  });
});

describe("codeLanguageOfPath", () => {
  it("只映射到已安装的四个 lang 包", () => {
    expect(codeLanguageOfPath("a.ts")).toBe("javascript");
    expect(codeLanguageOfPath("a.vue")).toBe("javascript");
    expect(codeLanguageOfPath("a.json")).toBe("json");
    expect(codeLanguageOfPath("a.md")).toBe("markdown");
    expect(codeLanguageOfPath("a.html")).toBe("html");
  });

  it("没装对应 lang 包的语言返回 null，交给纯文本渲染", () => {
    expect(codeLanguageOfPath("a.py")).toBeNull();
    expect(codeLanguageOfPath("a.rs")).toBeNull();
    expect(codeLanguageOfPath("Makefile")).toBeNull();
  });
});
