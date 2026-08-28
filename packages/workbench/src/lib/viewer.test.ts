import { describe, expect, it } from "vitest";
import { basename, kindOfPath } from "./viewer";

describe("kindOfPath", () => {
  it("按扩展名分派类型", () => {
    expect(kindOfPath("reports/weekly.md")).toBe("md");
    expect(kindOfPath("reports/genui/dashboard.html")).toBe("html");
    expect(kindOfPath("reports/data.csv")).toBe("csv");
    expect(kindOfPath("reports/task-result.xlsx")).toBe("xlsx");
    expect(kindOfPath("reports/task-brief.pptx")).toBe("pptx");
    expect(kindOfPath("docs/report.docx")).toBe("docx");
  });

  it("未知扩展归 raw，大小写不敏感", () => {
    expect(kindOfPath("src/main.ts")).toBe("raw");
    expect(kindOfPath("reports/UPPER.HTML")).toBe("html");
  });
});

describe("basename", () => {
  it("取路径末段", () => {
    expect(basename("reports/genui/a.html")).toBe("a.html");
    expect(basename("plain.txt")).toBe("plain.txt");
  });
});
