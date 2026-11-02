import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eventBinding, normalizeKeybindingKey, setKeybindingPlatformForTest } from "@/plugins/keybindings";

/**
 * 快捷键归一化：
 *  - manifest key 与键盘事件都归到同一串 canonical（修饰键按 mod/ctrl/alt/shift 序 + 小写主键）；
 *  - 非法形态 / 纯 shift / 未知修饰键返回 null；
 *  - mod = Cmd(mac) / Ctrl(其它)；声明 ctrl+x 在 mac 上命中的是 Ctrl 而不是 Cmd。
 */

function keyEvent(init: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): KeyboardEvent {
  // node 环境没有 KeyboardEvent 构造器：eventBinding 只读这几个字段，给个最小桩即可。
  return {
    key: init.key,
    metaKey: init.metaKey === true,
    ctrlKey: init.ctrlKey === true,
    altKey: init.altKey === true,
    shiftKey: init.shiftKey === true,
  } as KeyboardEvent;
}

describe("normalizeKeybindingKey", () => {
  it("合法形态归一化：修饰键排序、主键小写", () => {
    expect(normalizeKeybindingKey("mod+shift+p")).toBe("mod+shift+p");
    // 大小写不敏感，但乱序不归一化（与 Rust 安装期校验同一口径）。
    expect(normalizeKeybindingKey("MOD+SHIFT+P")).toBe("mod+shift+p");
    expect(normalizeKeybindingKey("ctrl+alt+k")).toBe("ctrl+alt+k");
    expect(normalizeKeybindingKey("F9")).toBe("f9");
  });

  it("非法形态返回 null：纯主键 / 纯 shift / 未知修饰 / 乱序 / 非法主键", () => {
    expect(normalizeKeybindingKey("p")).toBeNull();
    expect(normalizeKeybindingKey("shift+p")).toBeNull();
    expect(normalizeKeybindingKey("cmd+p")).toBeNull();
    expect(normalizeKeybindingKey("shift+mod+p")).toBeNull();
    expect(normalizeKeybindingKey("mod+esc")).toBeNull();
    expect(normalizeKeybindingKey("mod+")).toBeNull();
  });
});

describe("eventBinding", () => {
  beforeEach(() => setKeybindingPlatformForTest("other"));
  afterEach(() => setKeybindingPlatformForTest(null));
  it("Ctrl（非 mac 平台）归到 mod；Shift 参与组合", () => {
    expect(eventBinding(keyEvent({ key: "p", ctrlKey: true, shiftKey: true }))).toBe("mod+shift+p");
    expect(eventBinding(keyEvent({ key: "F9" }))).toBe("f9");
  });

  it("纯字母 / 纯 shift 不产生可匹配的组合键", () => {
    expect(eventBinding(keyEvent({ key: "p" }))).toBeNull();
    expect(eventBinding(keyEvent({ key: "P", shiftKey: true }))).toBeNull();
  });
});
