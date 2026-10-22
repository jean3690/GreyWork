import { describe, expect, it } from "vitest";

import { mergePathEntries } from "../src/shared/shell-path";

describe("登录 shell PATH 合并", () => {
  it("按首次出现位置去重并保序", () => {
    expect(mergePathEntries(["/login/bin:/usr/bin", "/usr/local/bin:/usr/bin", ""], ":")).toBe(
      "/login/bin:/usr/bin:/usr/local/bin",
    );
  });

  it("支持 Windows 分隔符", () => {
    expect(mergePathEntries(["C:\\Tools;C:\\Windows", "C:\\Windows;D:\\bin"], ";")).toBe(
      "C:\\Tools;C:\\Windows;D:\\bin",
    );
  });

  it("全空输入得到空串，不留下分隔符", () => {
    expect(mergePathEntries(["", ":", ""], ":")).toBe("");
  });
});
