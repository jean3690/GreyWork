// 后端选择条渲染契约：点击 ACP 胶囊 → 同处展开会话配置选择器（模型 / 思考强度 / 会话模式，
// 取决于 agent 在 session/new 暴露的 select 型配置）；模型未暴露思考强度时展示提示桩；
// 连接失败就地展示错误文案并可点击重试；已连接重复点击不再重复建会话。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { createPinia, setActivePinia } from "pinia";
import AcpSessionConfig from "@/components/AcpSessionConfig.vue";
import { i18n } from "@/i18n";
import AgentProviderBar from "@/components/AgentProviderBar.vue";
import { useAgentStore } from "@/stores/agent";

const h = vi.hoisted(() => ({
  startAgent: vi.fn(),
  openSession: vi.fn(),
  setSessionConfig: vi.fn(),
  setPermissionTier: vi.fn(),
  prompt: vi.fn(),
  respondPermission: vi.fn(),
  stop: vi.fn(),
  isAvailable: vi.fn(() => true),
  homeDir: vi.fn<() => Promise<string | null>>(() => Promise.resolve("/home/test")),
  listener: null as ((event: { kind: string; payload: unknown }) => void) | null,
}));

vi.mock("@greywork/acp", () => ({
  createAcpClient: () =>
    ({
      isAvailable: () => h.isAvailable(),
      startAgent: (cmd: string, tier: string) => h.startAgent(cmd, tier),
      openSession: (handle: number, cwd: string) => h.openSession(handle, cwd),
      setSessionConfig: (handle: number, configId: string, value: string | boolean) => h.setSessionConfig(handle, configId, value),
      setPermissionTier: (handle: number, tier: string) => h.setPermissionTier(handle, tier),
      prompt: (handle: number, text: string) => h.prompt(handle, text),
      stop: (handle: number, turnId?: number) => h.stop(handle, turnId),
      respondPermission: (requestId: number, optionId: string | null) => h.respondPermission(requestId, optionId),
      onEvent: (listener: (event: { kind: string; payload: unknown }) => void) => {
        h.listener = listener;
        return Promise.resolve(() => undefined);
      },
    }) as never,
  desktopHomeDir: () => h.homeDir(),
}));

function options(withEffort: boolean) {
  const configOptions = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "opencode/gpt-5-codex",
      options: [
        { value: "opencode/gpt-5-codex", name: "gpt-5-codex" },
        { value: "opencode/big-pickle", name: "big-pickle" },
      ],
    },
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: "build",
      options: [
        { value: "build", name: "build" },
        { value: "plan", name: "plan" },
      ],
    },
  ];
  if (withEffort) {
    configOptions.splice(1, 0, {
      id: "effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "low",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    });
  }
  return { sessionId: "session-1", configOptions };
}

/** 页面真实组合：后端选择条在上（点击触发建会话），会话配置选择簇在输入卡底栏（发送按钮旁）。 */
const Harness = defineComponent({
  components: { AgentProviderBar, AcpSessionConfig },
  template: "<div><AgentProviderBar /><AcpSessionConfig /></div>",
});

function mountBar() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(Harness, { global: { plugins: [pinia, i18n] } });
  return { pinia, wrapper };
}

function openCodeButton(wrapper: ReturnType<typeof mount>) {
  const buttons = wrapper.findAll("button");
  const target = buttons.find((button) => button.text().includes("OpenCode"));
  expect(target, "OpenCode 胶囊应存在").toBeDefined();
  return target!;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isAvailable.mockImplementation(() => true);
  h.homeDir.mockImplementation(() => Promise.resolve("/home/test"));
  h.listener = null;
});

describe("AgentProviderBar · ACP 会话配置选择器", () => {
  it("模型暴露 effort：底栏（发送按钮旁）渲染模型 / 思考强度 / 会话模式三组选择器", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue(options(true));
    const { wrapper } = mountBar();

    await openCodeButton(wrapper).trigger("click");
    await vi.waitFor(() => expect(h.openSession).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("gpt-5-codex"); // 模型
      expect(wrapper.text()).toContain("思考强度 · Low"); // effort 本地化标签 + 当前值
      expect(wrapper.text()).toContain("会话模式 · build"); // mode 本地化标签
      expect(wrapper.text()).not.toContain("模型不支持");
    });
  });

  it("当前模型不支持思考强度：连接后出现提示桩而非选择器", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue(options(false));
    const { wrapper } = mountBar();

    await openCodeButton(wrapper).trigger("click");
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("思考强度 · 模型不支持");
      expect(wrapper.text()).toContain("会话模式 · build");
    });
  });

  it("连接失败：胶囊旁出现错误行（含宿主原因），不出现模型选择", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockRejectedValue(new Error("agent handshake timeout"));
    const { wrapper } = mountBar();

    await openCodeButton(wrapper).trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[role="alert"]').exists()).toBe(true));
    expect(wrapper.text()).toContain("agent handshake timeout");
    expect(wrapper.text()).not.toContain("gpt-5-codex");

    // 修复后点击同一胶囊（仍选中态）→ 重试成功并出现选择器
    h.openSession.mockResolvedValue(options(true));
    await openCodeButton(wrapper).trigger("click");
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("思考强度 · Low");
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    });
    expect(h.startAgent).toHaveBeenCalledTimes(2);
  });

  it("已连接重复点击同胶囊：不再重复建会话", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue(options(true));
    const { wrapper } = mountBar();
    const agentStore = useAgentStore();

    await openCodeButton(wrapper).trigger("click");
    await vi.waitFor(() => expect(agentStore.acpConnected).toBe(true));
    expect(h.startAgent).toHaveBeenCalledTimes(1);

    await openCodeButton(wrapper).trigger("click");
    await flushPromises();
    expect(h.startAgent).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain("思考强度 · Low");
  });
});
