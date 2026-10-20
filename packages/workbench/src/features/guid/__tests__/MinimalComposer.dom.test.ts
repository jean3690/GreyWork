import { nextTick } from "vue";
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

  it("ACP 配置块默认收起：出折叠头 + 当前模型摘要，点开才铺开配置簇", async () => {
    const agent = useAgentStore();
    agent.routeToAcp = true;
    agent.acpConfigOptions = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "gpt-5",
        options: [
          { value: "gpt-5", name: "GPT-5" },
          { value: "local", name: "Local" },
        ],
      },
    ];

    const wrapper = mountComposer();
    await flushPromises();

    const toggle = wrapper.get('[data-testid="minimal-composer-config-toggle"]');
    // 默认收起：折叠头显示模型摘要，aria-expanded 明示状态
    expect(toggle.attributes("aria-expanded")).toBe("false");
    expect(toggle.text()).toContain("GPT-5");
    // 配置簇保持挂载（v-show）——切换后端 / 重连时能即时反映，不丢焦点
    expect(wrapper.findComponent(AcpSessionConfig).exists()).toBe(true);

    await toggle.trigger("click");
    expect(wrapper.get('[data-testid="minimal-composer-config-toggle"]').attributes("aria-expanded")).toBe("true");

    await toggle.trigger("click");
    expect(wrapper.get('[data-testid="minimal-composer-config-toggle"]').attributes("aria-expanded")).toBe("false");
  });

  it("模型无值时摘要回落「跟随 CLI」占位", async () => {
    const agent = useAgentStore();
    agent.routeToAcp = true;
    agent.acpConfigOptions = [{ id: "model", name: "Model", type: "select", currentValue: null, options: [] }];

    const wrapper = mountComposer();
    await flushPromises();

    expect(wrapper.get('[data-testid="minimal-composer-config-toggle"]').text()).toContain("跟随 CLI");
  });
});

describe("MinimalComposer 文本区自适应高度", () => {
  it("内容变多时按 scrollHeight 撑高，超上限封顶；清空回落最小高度", async () => {
    // happy-dom 不做布局，scrollHeight 恒为 0 —— 用属性桩给出可控的量高结果，只验证「取值口径」。
    const wrapper = mountComposer();
    const el = wrapper.get("textarea").element as HTMLTextAreaElement;
    let fake = 68;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => fake });

    await wrapper.get("textarea").setValue("一行");
    await nextTick();
    expect(el.style.height).toBe("68px");

    fake = 400; // 远超 176 上限 → 封顶，不允许输入卡无限长高把消息流挤没
    await wrapper.get("textarea").setValue("长文本".repeat(40));
    await nextTick();
    expect(el.style.height).toBe("176px");

    fake = 68;
    await wrapper.get("textarea").setValue("");
    await nextTick();
    expect(el.style.height).toBe("68px");
  });

  it("外部改草稿（如建议卡填入 / 取回待发）也触发重算，不只监听 input", async () => {
    const wrapper = mountComposer();
    const el = wrapper.get("textarea").element as HTMLTextAreaElement;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 132 });

    await wrapper.setProps({ modelValue: "外部填入的草稿" });
    await nextTick();
    expect(el.style.height).toBe("132px");
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

  it("Agent 胶囊：选择 ACP 后端走 activateAcpProvider（不再提供 Local 项）", async () => {
    const agent = useAgentStore();
    agent.agentProviders = [{ id: "codex", name: "Codex", kind: "acp", command: "codex", enabled: true }];
    const activateSpy = vi.spyOn(agent, "activateAcpProvider").mockResolvedValue(null);

    const wrapper = mountComposer();
    await wrapper.get('[data-testid="minimal-composer-agent"]').trigger("click");
    await flushPromises();
    expect(document.body.textContent).toContain("Codex");
    expect(document.body.querySelector('[data-testid="minimal-agent-local"]')).toBeNull();

    await menuItem("minimal-agent-codex").trigger("click");
    await flushPromises();
    expect(activateSpy).toHaveBeenCalledWith("codex");
    wrapper.unmount();
  });
});
