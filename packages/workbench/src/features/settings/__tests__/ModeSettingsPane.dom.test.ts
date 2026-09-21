// 设置 · 运行模式面板契约：hint 文案真的被 t() 转译（不是渲染出 i18n key）、
// 档位选择持久化（重启后仍是 worktree）、隔离快照行的回收入口接到宿主 worktree_release。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked((await import("@tauri-apps/api/core")).invoke);

import { i18n } from "@/i18n";
import ModeSettingsPane from "@/features/settings/ModeSettingsPane.vue";
import { useSettingsStore } from "@/stores/settings";

const mounted: VueWrapper[] = [];
/** 宿主返回的一条 git 快照。 */
const SNAPSHOT = { root: "/home/test/.greyWork/worktrees/proj-abc123", kind: "git", source: "/home/test/proj", bytes: 2048 };

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  invokeMock.mockReset();
  // 桌面态：isTauriRuntime() 看 window 上有没有 __TAURI_INTERNALS__。
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  i18n.global.locale.value = "zh-CN";
  invokeMock.mockImplementation(async (command: string) => (command === "worktree_list" ? [SNAPSHOT] : null));
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

async function render(): Promise<VueWrapper> {
  const wrapper = mount(ModeSettingsPane, { global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

/** 点确认弹层的确认按钮（Portal 到 body，wrapper.find 够不到）。 */
async function confirmDialog(): Promise<void> {
  const content = document.body.querySelector('[data-slot="alert-dialog-content"]');
  if (!content) throw new Error("未渲染出 alert-dialog-content");
  [...content.querySelectorAll<HTMLButtonElement>("button")][1]?.click();
  await flushPromises();
}

describe("ModeSettingsPane · 运行模式", () => {
  it("渲染转译后的中文 hint，而不是 i18n key 字面量", async () => {
    const wrapper = await render();

    expect(wrapper.text()).toContain("隔离执行：宿主派生独立 worktree");
    expect(wrapper.text()).not.toContain("settings.runModes");
  });

  it("选中 worktree 即持久化：新建 pinia 重载后仍是 worktree", async () => {
    const wrapper = await render();
    await wrapper.get('[data-testid="run-mode-worktree"]').trigger("click");
    expect(useSettingsStore().runMode).toBe("worktree");

    setActivePinia(createPinia());
    expect(useSettingsStore().runMode).toBe("worktree");
  });

  it("worktree 档位下提示写入落在快照里，不回到工作区", async () => {
    const wrapper = await render();
    await wrapper.get('[data-testid="run-mode-worktree"]').trigger("click");

    expect(wrapper.text()).toContain("agent 的写入不会出现在工作区文件树 / Git 面板");
  });
});

describe("ModeSettingsPane · 隔离快照回收", () => {
  it("列出宿主返回的快照行：kind 徽标、源目录、体积", async () => {
    const wrapper = await render();

    const rows = wrapper.findAll('[data-testid="worktree-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain("git worktree");
    expect(rows[0]!.text()).toContain(SNAPSHOT.root);
    expect(rows[0]!.text()).toContain(SNAPSHOT.source);
    expect(rows[0]!.text()).toContain("2.0 KB");
    expect(invokeMock).toHaveBeenCalledWith("worktree_list");
  });

  it("释放走二次确认，并以该行的 root 调宿主 worktree_release，成功后行消失", async () => {
    const wrapper = await render();

    await wrapper.get('[data-testid="worktree-release-proj-abc123"]').trigger("click");
    await flushPromises();
    expect(invokeMock).not.toHaveBeenCalledWith("worktree_release", expect.anything()); // 未确认前不落手

    await confirmDialog();

    expect(invokeMock).toHaveBeenCalledWith("worktree_release", { root: SNAPSHOT.root });
    expect(wrapper.findAll('[data-testid="worktree-row"]')).toHaveLength(0);
  });

  it("宿主拒绝释放：错误如实展示，行保留（不假装已删）", async () => {
    // 只让 worktree_release 失败：别的命令照常返回，免得设置/agent/session 的库加载
    // 被一起打挂、刷出一屏与本用例无关的降级日志。
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "worktree_list") return [SNAPSHOT];
      if (command === "worktree_release") throw new Error("只允许释放 ~/.greyWork/worktrees 下的隔离快照");
      return null;
    });
    const wrapper = await render();

    await wrapper.get('[data-testid="worktree-release-proj-abc123"]').trigger("click");
    await flushPromises();
    await confirmDialog();

    expect(wrapper.text()).toContain("只允许释放 ~/.greyWork/worktrees 下的隔离快照");
    expect(wrapper.findAll('[data-testid="worktree-row"]')).toHaveLength(1);
  });
});

describe("ModeSettingsPane · 浏览器态", () => {
  it("无宿主：快照面板标只读并禁用释放，不往返 IPC", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    const wrapper = await render();

    expect(wrapper.text()).toContain("查看与释放需要桌面版（Tauri）");
    expect(invokeMock).not.toHaveBeenCalledWith("worktree_list");
    expect(wrapper.findAll('[data-testid="worktree-row"]')).toHaveLength(0);
  });
});
