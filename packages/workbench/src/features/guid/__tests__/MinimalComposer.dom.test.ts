import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import MinimalComposer from "@/features/guid/MinimalComposer.vue";
import AcpSessionConfig from "@/features/conversation/AcpSessionConfig.vue";
import { i18n } from "@/i18n";
import { useAgentStore } from "@/stores/agent";
import { useWorkspaceStore } from "@/stores/workspace";

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
});

afterEach(() => {
  // 只清 Portal 出来的弹层节点，不动 VTU 的挂载容器。
  document.body.innerHTML = "";
});

function mountComposer(props: Record<string, unknown> = {}) {
  return mount(MinimalComposer, {
    props: {
      modelValue: "",
      busy: false,
      canSend: false,
      placeholder: "说出你的想法…",
      ...props,
    },
    global: { plugins: [i18n] },
  });
}

/** Portal 到 body 的菜单项；不存在时抛（断言更直白）。 */
function menuItem(testid: string): DOMWrapper<Element> {
  const element = document.body.querySelector(`[data-testid="${testid}"]`);
  expect(element, `菜单项 ${testid}`).not.toBeNull();
  return new DOMWrapper(element!);
}

describe("MinimalComposer 极简输入卡", () => {
  it("渲染 chips 行、文本区与动作行（工作区回落「普通对话」）", () => {
    const wrapper = mountComposer();

    expect(wrapper.find('[data-testid="minimal-composer-chips"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="minimal-composer-workspace"]').text()).toContain("普通对话");
    expect(wrapper.get("textarea").attributes("placeholder")).toBe("说出你的想法…");
    expect(wrapper.find('[data-testid="minimal-composer-attach"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="minimal-composer-agent"]').exists()).toBe(true);
  });

  it("输入即上报 update:modelValue，键盘事件原样上报给宿主", async () => {
    const wrapper = mountComposer();

    await wrapper.get("textarea").setValue("改一下标题");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["改一下标题"]);

    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("keydown")).toHaveLength(1);
  });

  it("canSend 为假时发送键禁用；为真时点击上报 submit", async () => {
    const disabled = mountComposer({ canSend: false });
    expect(disabled.get('[data-testid="minimal-composer-send"]').attributes("disabled")).toBeDefined();
    await disabled.get('[data-testid="minimal-composer-send"]').trigger("click");
    expect(disabled.emitted("submit")).toBeUndefined();

    const enabled = mountComposer({ canSend: true });
    await enabled.get('[data-testid="minimal-composer-send"]').trigger("click");
    expect(enabled.emitted("submit")).toHaveLength(1);
  });

  it("附件键上报 attach；忙碌态显示转动指示", async () => {
    const wrapper = mountComposer({ busy: true });

    expect(wrapper.find('[data-testid="minimal-composer-busy"]').exists()).toBe(true);
    await wrapper.get('[data-testid="minimal-composer-attach"]').trigger("click");
    expect(wrapper.emitted("attach")).toHaveLength(1);
  });

  it("ACP 路由下在发送框下方渲染完整会话配置块（复用 AcpSessionConfig）", async () => {
    const agent = useAgentStore();
    agent.routeToAcp = true;

    const wrapper = mountComposer();
    await flushPromises();

    expect(wrapper.findComponent(AcpSessionConfig).exists()).toBe(true);
    // 独立成块（在输入卡之外），而不是塞进 chips 行
    expect(wrapper.find('[data-testid="minimal-composer-config"]').exists()).toBe(true);
    // AgentScopeSelect 的权限胶囊（完整外壳配置簇的一员，早先极简这边漏掉）
    expect(wrapper.text()).toContain("权限");
  });

  it("本地路由下不渲染配置块（不留空盒）", async () => {
    const wrapper = mountComposer();
    expect(wrapper.find('[data-testid="minimal-composer-config"]').exists()).toBe(false);
  });
});

describe("MinimalComposer 配置下拉", () => {
  it("工作区胶囊：下拉切换 activeWorkspaceId", async () => {
    const workspaceStore = useWorkspaceStore();
    const alpha = workspaceStore.createWorkspace("Alpha");
    const beta = workspaceStore.createWorkspace("Beta");
    expect(workspaceStore.activeWorkspaceId).toBe(beta.id);

    const wrapper = mountComposer();
    await wrapper.get('[data-testid="minimal-composer-workspace"]').trigger("click");
    await flushPromises();

    await menuItem(`minimal-workspace-${alpha.id}`).trigger("click");
    await flushPromises();

    expect(workspaceStore.activeWorkspaceId).toBe(alpha.id);
    wrapper.unmount();
  });

  it("Agent 胶囊：Local 走 switchToLocalLlm，ACP 后端走 activateAcpProvider", async () => {
    const agent = useAgentStore();
    agent.agentProviders = [{ id: "codex", name: "Codex", kind: "acp", command: "codex", enabled: true }];
    const localSpy = vi.spyOn(agent, "switchToLocalLlm").mockResolvedValue(undefined);
    const activateSpy = vi.spyOn(agent, "activateAcpProvider").mockResolvedValue(null);

    const wrapper = mountComposer();
    await wrapper.get('[data-testid="minimal-composer-agent"]').trigger("click");
    await flushPromises();
    expect(document.body.textContent).toContain("Codex");

    await menuItem("minimal-agent-local").trigger("click");
    await flushPromises();
    expect(localSpy).toHaveBeenCalledTimes(1);

    await wrapper.get('[data-testid="minimal-composer-agent"]').trigger("click");
    await flushPromises();
    await menuItem("minimal-agent-codex").trigger("click");
    await flushPromises();
    expect(activateSpy).toHaveBeenCalledWith("codex");
    wrapper.unmount();
  });
});
