/**
 * 产物查看器分派：kind 判定是唯一的「按什么打开」决策点，二进制白名单更是
 * 防止 xlsx 被当文本读坏的护栏 —— 两者都必须有用例守住。
 */
import { describe, expect, it } from "vitest";
import { basename, codeLanguageOfPath, isBinaryKind, isMediaKind, kindOfPath, mediaLimitOfKind, type ViewerKind } from "@/lib/viewer";

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
    ["brief.docx", "docx"],
    ["deck.pptx", "pptx"],
    ["manual.pdf", "pdf"],
    // 老格式必须与各自的 OOXML 新格式分开：解析器读不了 OLE2，
    // 混为一谈会让用户拿到一个「文件已损坏」的解析错误而不是明确提示。
    ["legacy.doc", "legacy-office"],
    ["template.dot", "legacy-office"],
    // 老格式表格例外：宿主用 calamine 按内容嗅探，真的能读，所以单独成类而不是占位提示。
    ["legacy.xls", "xls"],
    ["template.xlt", "xls"],
    ["legacy.ppt", "legacy-office"],
    ["fix.diff", "diff"],
    ["fix.patch", "diff"],
    ["logo.png", "image"],
    ["logo.svg", "image"],
    // 视频必须单独成类：落到 raw 会被当文本读，二进制经 utf-8 解码就是一屏乱码且不报错。
    // mov / mkv 能否真播出取决于宿主解码器，但「有没有走对通道」与解码器无关。
    ["clip.mp4", "video"],
    ["clip.m4v", "video"],
    ["clip.webm", "video"],
    ["clip.mov", "video"],
    ["clip.mkv", "video"],
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

  it("目录名里的点不算扩展名（曾经从整条路径 split('.') 取，会拿到垃圾串）", () => {
    // "v1.2/report" 曾经被判成扩展名 "2/report"；现在只在末段上找点。
    expect(kindOfPath("v1.2/report")).toBe("raw");
    expect(kindOfPath("v1.2/report.md")).toBe("md");
    expect(kindOfPath("C:\\ws\\v1.2\\logo.png")).toBe("image");
  });
});

describe("isBinaryKind", () => {
  it.each<ViewerKind>(["xlsx", "xls", "docx", "pptx", "pdf", "image", "video", "legacy-office"])("%s 必须按二进制读", (kind) => {
    expect(isBinaryKind(kind)).toBe(true);
  });

  it.each<ViewerKind>(["md", "html", "csv", "code", "diff", "raw"])("%s 按文本读", (kind) => {
    expect(isBinaryKind(kind)).toBe(false);
  });

  it("老格式按二进制读是硬要求：走文本通道会被 utf-8 解码成乱码且不报错", () => {
    // .doc / .xls / .ppt 都是 OLE2 二进制；曾经的 bug 就是它们落到 raw 走了文本通道。
    for (const path of ["a.doc", "a.xls", "a.ppt"]) {
      expect(isBinaryKind(kindOfPath(path))).toBe(true);
    }
  });
});

describe("媒体读取通道", () => {
  it("视频走媒体通道，申请额度远高于 20MB 硬顶", () => {
    // 按 20MB 卡死等于真实视频一律打不开 —— 这个分派正是视频预览能成立的前提。
    expect(isMediaKind("video")).toBe(true);
    expect(mediaLimitOfKind("video")).toBeGreaterThan(20 * 1024 * 1024);
  });

  it("非媒体 kind 不走媒体通道（仍旧 20MB 契约）", () => {
    for (const kind of ["image", "pdf", "docx", "xlsx", "legacy-office", "md", "code"] as ViewerKind[]) {
      expect(isMediaKind(kind)).toBe(false);
      expect(mediaLimitOfKind(kind)).toBeUndefined();
    }
  });
});

describe("basename", () => {
  it("取末段；无斜杠时原样返回", () => {
    expect(basename("reports/2026/a.md")).toBe("a.md");
    expect(basename("a.md")).toBe("a.md");
  });

  it("以斜杠结尾时先剥掉分隔符再取末段（与 core 的 normalizePath 同语义）", () => {
    expect(basename("reports/")).toBe("reports");
  });

  it("Windows 分隔符一样认", () => {
    expect(basename("C:\\ws\\reports\\a.md")).toBe("a.md");
  });
});

describe("codeLanguageOfPath", () => {
  it("映射到已安装的 lang 包（每个语言抽一个代表扩展）", () => {
    expect(codeLanguageOfPath("a.ts")).toBe("javascript");
    expect(codeLanguageOfPath("a.tsx")).toBe("javascript");
    expect(codeLanguageOfPath("a.json")).toBe("json");
    expect(codeLanguageOfPath("a.md")).toBe("markdown");
    expect(codeLanguageOfPath("a.html")).toBe("html");
    expect(codeLanguageOfPath("main.py")).toBe("python");
    expect(codeLanguageOfPath("lib.rs")).toBe("rust");
    expect(codeLanguageOfPath("main.go")).toBe("go");
    expect(codeLanguageOfPath("App.java")).toBe("java");
    expect(codeLanguageOfPath("a.cpp")).toBe("cpp");
    expect(codeLanguageOfPath("a.hpp")).toBe("cpp");
    expect(codeLanguageOfPath("style.css")).toBe("css");
    expect(codeLanguageOfPath("style.scss")).toBe("sass");
    expect(codeLanguageOfPath("style.less")).toBe("less");
    expect(codeLanguageOfPath("ci.yml")).toBe("yaml");
    expect(codeLanguageOfPath("query.sql")).toBe("sql");
    expect(codeLanguageOfPath("config.xml")).toBe("xml");
    expect(codeLanguageOfPath("Cargo.toml")).toBe("toml");
    expect(codeLanguageOfPath("build.sh")).toBe("shell");
    expect(codeLanguageOfPath("App.vue")).toBe("vue");
  });

  it("扩展名大小写不敏感", () => {
    expect(codeLanguageOfPath("MAIN.PY")).toBe("python");
    expect(codeLanguageOfPath("App.VUE")).toBe("vue");
  });

  it("没有语言映射的扩展返回 null，交给纯文本渲染", () => {
    expect(codeLanguageOfPath("Makefile")).toBeNull();
    expect(codeLanguageOfPath("a.rb")).toBeNull();
  });
});
