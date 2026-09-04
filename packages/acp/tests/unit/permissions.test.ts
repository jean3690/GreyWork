// permissions.ts classify 层：ACP 选项 kind → 意图归一化、工具操作分类、
// auto 档安全兜底、面板展示模型。全部纯函数，无 mock。
import { describe, expect, it } from "vitest";
import { classifyAcpPermission, normalizePermissionOperationKind, safeAllowOnceId, toPermissionPanelOptions } from "../../src/permissions";

describe("classifyAcpPermission", () => {
  it("maps ACP kinds to intents and is conservative on unknowns", () => {
    expect(classifyAcpPermission("allow_once")).toBe("allow-once");
    expect(classifyAcpPermission("allow_always")).toBe("allow-always");
    expect(classifyAcpPermission("reject_once")).toBe("reject-once");
    expect(classifyAcpPermission("reject_always")).toBe("reject-always");
    expect(classifyAcpPermission("weird_kind")).toBe("neutral");
    expect(classifyAcpPermission(undefined)).toBe("neutral");
    expect(classifyAcpPermission(null)).toBe("neutral");
  });
});

describe("normalizePermissionOperationKind", () => {
  it("normalizes aliases and defaults to tool", () => {
    expect(normalizePermissionOperationKind("exec")).toBe("execute");
    expect(normalizePermissionOperationKind("bash")).toBe("execute");
    expect(normalizePermissionOperationKind("write")).toBe("edit");
    expect(normalizePermissionOperationKind("delete")).toBe("edit");
    expect(normalizePermissionOperationKind("read")).toBe("read");
    expect(normalizePermissionOperationKind("web_search")).toBe("fetch");
    expect(normalizePermissionOperationKind("unknown")).toBe("tool");
    expect(normalizePermissionOperationKind(undefined)).toBe("tool");
  });
});

describe("safeAllowOnceId", () => {
  it("picks the first allow-once option and null otherwise", () => {
    const options: { optionId: string; kind: string }[] = [
      { optionId: "rej", kind: "reject_once" },
      { optionId: "ok", kind: "allow_once" },
      { optionId: "always", kind: "allow_always" },
    ];
    expect(safeAllowOnceId(options)).toBe("ok");
    expect(safeAllowOnceId([{ optionId: "only-reject", kind: "reject_always" }])).toBeNull();
    expect(safeAllowOnceId([])).toBeNull();
  });
});

describe("toPermissionPanelOptions", () => {
  it("builds stable ids, labels and intents", () => {
    const panels = toPermissionPanelOptions([
      { optionId: "opt-a", name: "Allow once", kind: "allow_once" },
      { optionId: "opt-b", name: "", kind: "reject_always" },
      { optionId: "opt-c", name: "Mystery", kind: "mystery" },
    ]);
    expect(panels).toEqual([
      { id: "opt-a:0", value: "opt-a", label: "Allow once", intent: "allow-once" },
      { id: "opt-b:1", value: "opt-b", label: "opt-b", intent: "reject-always" },
      { id: "opt-c:2", value: "opt-c", label: "Mystery", intent: "neutral" },
    ]);
  });
});
