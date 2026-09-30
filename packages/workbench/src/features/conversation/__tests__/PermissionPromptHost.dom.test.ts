// 全局权限浮层的回归哨兵：活跃态权限卡片必须在**任何路由**都能看到并裁决。
//
// 背景：卡片原先只挂在会话页的输入区，而会话页是路由级组件 —— 后台任务 / 远程助手 /
// 定时任务触发的 ACP 权限请求（或用户停在引导页 / 团队页时），宿主只发了系统通知，
// 界面上没有裁决入口，请求干等到 120s 超时被自动拒绝。这个用例盯住「提到外壳顶层」
// 这条判断不被改回会话页。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const h = vi.hoisted(() => ({ respondPermission: vi.fn() }));

vi.mock("@greywork/acp", () => ({
  createAcpClient: () =>
    ({
      isAvailable: () => true,
      respondPermission: (requestId: number, optionId: string | null) => h.respondPermission(requestId, optionId),
      onEvent: () => Promise.resolve(() => undefined),
    }) as never,
}));

import PermissionPromptHost from "@/features/conversation/PermissionPromptHost.vue";
import { useAgentStore } from "@/stores/agent";

/** 挂载过的 wrapper：有待决请求时卡片会起 250ms 倒计时 interval，卸载才清得掉。 */
const mounted: VueWrapper[] = [];

function mountHost() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const agent = useAgentStore();
  const wrapper = mount(PermissionPromptHost, { global: { plugins: [pinia] }, attachTo: document.body });
  mounted.push(wrapper);
  return { wrapper, agent };
}

/** 造一条待裁决请求（两个选项：允许一次 / 始终允许）。 */
function armPending(agent: ReturnType<typeof useAgentStore>): void {
  agent.pendingPermission = {
    requestId: 7,
    auto: false,
    chosen: null,
    toolCallId: "call-1",
    title: "写入 /home/test/notes.md",
    kind: "edit",
    options: [
      { optionId: "once", name: "允许一次", kind: "allow_once" },
      { optionId: "always", name: "始终允许", kind: "allow_always" },
    ],
  };
  agent.permissionDeadline = Date.now() + 120_000;
}

beforeEach(() => {
  window.localStorage.clear();
  h.respondPermission.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("PermissionPromptHost", () => {
  it("无待决请求时整层不渲染", () => {
    const { wrapper } = mountHost();
    expect(wrapper.find('[data-testid="permission-prompt-host"]').exists()).toBe(false);
  });

  it("有待决请求时渲染全局浮层与卡片（非模态：外层不吃点击）", async () => {
    const { wrapper, agent } = mountHost();
    armPending(agent);
    await wrapper.vm.$nextTick();

    const host = wrapper.get('[data-testid="permission-prompt-host"]');
    expect(host.classes()).toContain("pointer-events-none");
    expect(host.classes()).toContain("fixed");
    expect(wrapper.find('[data-testid="permission-card"]').exists()).toBe(true);
  });

  it("裁决选项可点：回传宿主并收起卡片", async () => {
    const { wrapper, agent } = mountHost();
    armPending(agent);
    await wrapper.vm.$nextTick();

    await wrapper.get('[data-testid="permission-option-allow-once"]').trigger("click");
    await wrapper.vm.$nextTick();

    expect(h.respondPermission).toHaveBeenCalledWith(7, "once");
    expect(agent.pendingPermission).toBeNull();
    expect(wrapper.find('[data-testid="permission-prompt-host"]').exists()).toBe(false);
  });
});
