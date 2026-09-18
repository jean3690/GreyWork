import { describe, expect, it } from "vitest";
import { isAbsolutePath, joinPath, normalizePath } from "../../src/paths";

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
