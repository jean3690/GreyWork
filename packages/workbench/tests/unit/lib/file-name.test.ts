import { describe, expect, it } from "vitest";
import { isUsableName, nameProblem } from "@/lib/file-name";

describe("file-name", () => {
  it("普通名字可用（含中文、空格、点开头的隐藏文件、多后缀）", () => {
    for (const name of ["a.txt", "报告 2026.md", ".gitignore", "a.tar.gz", "CONSOLE", "COM10", "COMx"]) {
      expect(nameProblem(name), name).toBeNull();
      expect(isUsableName(name), name).toBe(true);
    }
  });

  it("空名字（含纯空白）判为 empty", () => {
    expect(nameProblem("")).toBe("empty");
    expect(nameProblem("   ")).toBe("empty");
  });

  it("`.` 与 `..` 被拒", () => {
    expect(nameProblem(".")).toBe("dot");
    expect(nameProblem("..")).toBe("dot");
  });

  it("路径分隔符与 Windows 非法字符被拒", () => {
    for (const name of ["a/b", "a\\b", "a<b", "a>b", 'a"b', "a|b", "a?b", "a*b", "a:b"]) {
      expect(nameProblem(name), name).toBe("illegal");
    }
    expect(nameProblem("a\u0000b")).toBe("illegal");
  });

  it("结尾的点被拒（Win32 会静默剥掉，与不带点的名字撞车）", () => {
    expect(nameProblem("foo.")).toBe("trailing");
  });

  it("结尾空格按 trim 处理：正常名字带尾随空格仍可用", () => {
    // 调用方提交的是 trim 后的值，所以这里不该报「结尾空格」以外的错
    expect(nameProblem("foo ")).toBeNull();
  });

  it("Win32 保留设备名被拒（大小写不敏感、带扩展名也算）", () => {
    for (const name of ["CON", "con", "Con.txt", "NUL", "aux", "COM1", "lpt9", "PRN"]) {
      expect(nameProblem(name), name).toBe("reserved");
    }
  });
});
