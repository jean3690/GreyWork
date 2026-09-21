// 版本比较是「有没有新版」判定的唯一依据，误判会漏报或误报更新，值得钉死。
import { describe, expect, it } from "vitest";
import { isNewerVersion } from "@/lib/update-backend";

describe("isNewerVersion", () => {
  it("逐段数值比较，主/次/修订任一更大即为新", () => {
    expect(isNewerVersion("0.2.0", "0.1.1")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.1.2", "0.1.1")).toBe(true);
  });

  it("相等或更旧不算新", () => {
    expect(isNewerVersion("0.1.1", "0.1.1")).toBe(false);
    expect(isNewerVersion("0.1.0", "0.1.1")).toBe(false);
    expect(isNewerVersion("1.9.9", "2.0.0")).toBe(false);
  });

  it("缺段按 0 补齐（0.2 视作 0.2.0）", () => {
    expect(isNewerVersion("0.2", "0.2.0")).toBe(false);
    expect(isNewerVersion("0.2.1", "0.2")).toBe(true);
  });

  it("预发布后缀不参与比较（只看数字段）", () => {
    expect(isNewerVersion("0.2.0-beta.1", "0.2.0")).toBe(false);
    expect(isNewerVersion("0.3.0-rc.1", "0.2.0")).toBe(true);
  });

  it("空/非法版本保守判 false，不误报有更新", () => {
    expect(isNewerVersion("", "0.1.0")).toBe(false);
    expect(isNewerVersion("latest", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.2.0", "")).toBe(false);
  });
});
