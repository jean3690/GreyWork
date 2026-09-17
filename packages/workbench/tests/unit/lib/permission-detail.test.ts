// 权限明细提取：agent 的 rawInput 键名各家自定，这里只做「有就显示」的机会性取值。
// 认不出时返回 null 很重要——猜错键名会把 undefined 渲染进卡片。
import { describe, expect, it } from "vitest";
import { clipPermissionDetail, permissionCommand } from "@/lib/permission-detail";

describe("permissionCommand", () => {
  it("取到 opencode bash 的命令正文", () => {
    expect(permissionCommand({ command: "rm -rf build" })).toBe("rm -rf build");
  });

  it("前后空白去掉", () => {
    expect(permissionCommand({ command: "  echo hi  " })).toBe("echo hi");
  });

  it("认不出的形状返回 null（不猜键名，也不吐 undefined）", () => {
    expect(permissionCommand({ script: "echo hi" })).toBeNull();
    expect(permissionCommand({ command: 42 })).toBeNull();
    expect(permissionCommand({ command: "   " })).toBeNull();
    expect(permissionCommand(undefined)).toBeNull();
    expect(permissionCommand(null)).toBeNull();
    expect(permissionCommand("command")).toBeNull();
  });
});

describe("clipPermissionDetail", () => {
  it("短文本原样返回", () => {
    expect(clipPermissionDetail("echo hi")).toBe("echo hi");
  });

  it("超长截断并加省略号——一整段脚本不能把输入框顶出屏幕", () => {
    const long = "x".repeat(500);
    const clipped = clipPermissionDetail(long, 100);
    expect(clipped).toHaveLength(101);
    expect(clipped.endsWith("…")).toBe(true);
  });
});
