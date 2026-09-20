import { describe, expect, it } from "vitest";
import { basename, extname, isAbsolutePath, joinPath, normalizePath } from "../../src/paths";

describe("isAbsolutePath", () => {
  it("认 POSIX 与 Windows 的绝对形态", () => {
    expect(isAbsolutePath("/home/u/ws")).toBe(true);
    expect(isAbsolutePath("/")).toBe(true);
    expect(isAbsolutePath("C:\\ws")).toBe(true);
    expect(isAbsolutePath("C:/ws")).toBe(true);
    expect(isAbsolutePath("C:\\")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share")).toBe(true);
    // 宿主剥掉 `\\?\` 前缀前也会经过这里，不能漏
    expect(isAbsolutePath("\\\\?\\C:\\ws")).toBe(true);
  });

  it("拒绝盘符相对路径 C:foo（它会在 join 时替换掉基准目录）", () => {
    expect(isAbsolutePath("C:foo")).toBe(false);
    expect(isAbsolutePath("C:")).toBe(false);
    expect(isAbsolutePath("c:evil")).toBe(false);
  });

  it("拒绝相对路径与空串", () => {
    expect(isAbsolutePath("ws/sub")).toBe(false);
    expect(isAbsolutePath("./ws")).toBe(false);
    expect(isAbsolutePath("../ws")).toBe(false);
    expect(isAbsolutePath("")).toBe(false);
  });
});

describe("joinPath", () => {
  it("沿用 parent 的分隔符，不混用", () => {
    expect(joinPath("C:\\ws", ".agents", "skills")).toBe("C:\\ws\\.agents\\skills");
    expect(joinPath("/home/u/ws", ".agents", "skills")).toBe("/home/u/ws/.agents/skills");
    expect(joinPath("C:/ws", "artifacts")).toBe("C:/ws/artifacts");
  });

  it("parent 以分隔符结尾时不重复拼", () => {
    expect(joinPath("/home/u/", "a")).toBe("/home/u/a");
    expect(joinPath("C:\\ws\\", "a")).toBe("C:\\ws\\a");
  });

  it("根目录不会丢掉前导分隔符", () => {
    expect(joinPath("/", "home")).toBe("/home");
    expect(joinPath("C:\\", "ws")).toBe("C:\\ws");
  });

  it("跳过空段、剥掉段的前导分隔符", () => {
    expect(joinPath("/a", "", "b")).toBe("/a/b");
    expect(joinPath("/a", "/b")).toBe("/a/b");
    expect(joinPath("", "a", "b")).toBe("a/b");
    expect(joinPath("/a")).toBe("/a");
  });

  it("没有分隔符的 parent（如未绑定的『工作区』占位）按 / 拼", () => {
    expect(joinPath("工作区", ".agents", "skills")).toBe("工作区/.agents/skills");
  });
});

describe("normalizePath", () => {
  it("反斜杠统一成 /，去掉尾部斜杠", () => {
    expect(normalizePath("\\\\?\\C:\\ws\\a")).toBe("//?/C:/ws/a");
    expect(normalizePath("C:\\ws\\a\\")).toBe("C:/ws/a");
    expect(normalizePath("/a/b/")).toBe("/a/b");
    expect(normalizePath("/a/b")).toBe("/a/b");
  });

  it("根目录不会归一成空串", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("C:\\")).toBe("C:");
  });

  it("不折大小写：Linux 上仅大小写不同的目录是两回事", () => {
    expect(normalizePath("/Home/User")).not.toBe(normalizePath("/home/user"));
  });
});

describe("basename", () => {
  it("POSIX 与 Windows 两种分隔符都认", () => {
    expect(basename("/home/u/ws/a.md")).toBe("a.md");
    expect(basename("C:\\ws\\a.md")).toBe("a.md");
    expect(basename("C:/ws/a.md")).toBe("a.md");
    // 混用分隔符（宿主给的是反斜杠，前端拼过 / 之后可能混）
    expect(basename("C:\\ws/sub/a.md")).toBe("a.md");
  });

  it("UNC 与 verbatim 前缀不影响末段", () => {
    expect(basename("\\\\server\\share\\a.md")).toBe("a.md");
    expect(basename("\\\\?\\C:\\ws\\a.md")).toBe("a.md");
  });

  it("尾部分隔符先剥掉，不返回空串（与 normalizePath 对齐）", () => {
    expect(basename("reports/")).toBe("reports");
    expect(basename("C:\\ws\\")).toBe("ws");
    expect(basename("a//")).toBe("a");
  });

  it("没有末段的路径返回空串，由调用方兜底", () => {
    expect(basename("/")).toBe("");
    expect(basename("\\\\")).toBe("");
    expect(basename("")).toBe("");
  });

  it("没有分隔符时原样返回（裸文件名与盘符相对路径）", () => {
    expect(basename("a.md")).toBe("a.md");
    expect(basename("C:")).toBe("C:");
  });

  it("不折大小写", () => {
    expect(basename("/home/u/A.MD")).toBe("A.MD");
  });
});

describe("extname", () => {
  it("取最后一个点之后的段，无点返回空串", () => {
    expect(extname("a.md")).toBe("md");
    expect(extname("/home/u/ws/a.md")).toBe("md");
    expect(extname("C:\\ws\\a.md")).toBe("md");
    expect(extname("Makefile")).toBe("");
    expect(extname("")).toBe("");
  });

  it("不改大小写（由调用方决定是否折）", () => {
    expect(extname("REPORT.MD")).toBe("MD");
  });

  it("只看末段：带点的目录名不会被算成扩展名", () => {
    // 这正是从整条路径 split(".").pop() 会取到 "2/report" 的场景
    expect(extname("/home/u/v1.2/report")).toBe("");
    expect(extname("C:\\ws\\v1.2\\report")).toBe("");
    // 带点的目录 + 真扩展名
    expect(extname("/home/u/v1.2/report.xlsx")).toBe("xlsx");
  });

  it("前导点是隐藏文件名、尾点不算扩展名", () => {
    expect(extname(".gitignore")).toBe("");
    expect(extname("/home/u/.gitignore")).toBe("");
    expect(extname("a.")).toBe("");
  });

  it("多点只取最后一段", () => {
    expect(extname("archive.tar.gz")).toBe("gz");
    expect(extname("report.2026.csv")).toBe("csv");
  });

  it("尾部分隔符先剥掉再取，与 basename 一致", () => {
    expect(extname("/home/u/ws/")).toBe("");
    expect(extname("/home/u/a.md/")).toBe("md");
  });
});
