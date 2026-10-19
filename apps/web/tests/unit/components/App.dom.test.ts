/**
 * Web 外壳根组件：只验证「AuthGate 包住 Shell」这一层结构与「没有全局拖放监听」。
 *
 * 登录门自身的分岔逻辑由 workbench 的 AuthGate.dom.test.ts 覆盖，这里不重复。
 * 本端刻意没有桌面端那套拖放接线（浏览器里 File 拿不到磁盘绝对路径，见 src/App.vue），
 * 所以这里也没有对应的正向用例 —— 第二条用例锁的正是「没有」，将来给 Web 端补拖放时它会红，
 * 提醒补上属于 Web 端自己的契约。
 */
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import App from "../../../src/App.vue";

vi.mock("@greywork/workbench", () => ({
  Shell: { name: "ShellStub", template: '<div data-testid="shell-stub" />' },
  AuthGate: { name: "AuthGateStub", template: '<div data-testid="auth-gate"><slot /></div>' },
}));

describe("Web App 外壳", () => {
  it("AuthGate 包住 Shell：未认证时登录门在外、Shell 在内", () => {
    const wrapper = mount(App);
    const gate = wrapper.find('[data-testid="auth-gate"]');
    expect(gate.exists()).toBe(true);
    expect(gate.find('[data-testid="shell-stub"]').exists()).toBe(true);
  });

  it("不装全局拖放监听", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    try {
      mount(App);
      const types = addSpy.mock.calls.map((call) => String(call[0]));
      expect(types).not.toContain("drop");
      expect(types).not.toContain("dragover");
    } finally {
      addSpy.mockRestore();
    }
  });
});
