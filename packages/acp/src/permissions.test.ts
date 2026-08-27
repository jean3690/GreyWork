// Phase 5：权限档位 → ACP 确认模式映射单测。
import { describe, expect, it } from "vitest";
import { isDestructiveIntent, permissionTierToAcpMode, shouldConfirmBeforeDispatch } from "./permissions";

describe("permissionTierToAcpMode", () => {
  it("maps tiers to ACP confirmation modes", () => {
    expect(permissionTierToAcpMode("cautious")).toBe("confirm-each");
    expect(permissionTierToAcpMode("daily")).toBe("confirm-destructive");
    expect(permissionTierToAcpMode("auto")).toBe("auto-approve");
  });
});

describe("shouldConfirmBeforeDispatch", () => {
  it("always confirms in cautious tier", () => {
    expect(shouldConfirmBeforeDispatch("cautious", "读取目录")).toBe(true);
  });

  it("only confirms destructive intents in daily tier", () => {
    expect(shouldConfirmBeforeDispatch("daily", "读取目录")).toBe(false);
    expect(shouldConfirmBeforeDispatch("daily", "删除 build 产物")).toBe(true);
    expect(shouldConfirmBeforeDispatch("daily", "git push --force origin main")).toBe(true);
  });

  it("never confirms in auto tier", () => {
    expect(shouldConfirmBeforeDispatch("auto", "删除 build 产物")).toBe(false);
  });
});

describe("isDestructiveIntent", () => {
  it("detects destructive keywords case-insensitively", () => {
    expect(isDestructiveIntent("RM -rf /")).toBe(true);
    expect(isDestructiveIntent("drop table users")).toBe(true);
    expect(isDestructiveIntent("正常分析任务")).toBe(false);
  });
});
