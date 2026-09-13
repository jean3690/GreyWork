// 后端选择条渲染契约：点击 ACP 胶囊 → 同处展开会话配置选择器（模型 / 思考强度 / 会话模式，
// 取决于 agent 在 session/new 暴露的 select 型配置）；模型未暴露思考强度时展示提示桩；
// 连接失败就地展示错误文案并可点击重试；已连接重复点击不再重复建会话。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent } from "vue";
import { createPinia, setActivePinia } from "pinia";
import AcpSessionConfig from "@/components/AcpSessionConfig.vue";
import { i18n } from "@/i18n";
import AgentProviderBar from "@/components/AgentProviderBar.vue";
import { useAgentStore } from "@/stores/agent";
import { useSettingsStore } from "@/stores/settings";

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
  invoke: vi.fn<(cmd: string, args?: { programs?: string[] }) => Promise<unknown>>(() => Promise.resolve([])),
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

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => (h.invoke as (...a: unknown[]) => Promise<unknown>)(...args) }));

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
  // ACP 建会话要解析工作区：happy-dom 非 Tauri 运行时，设置项为空则 resolveWorkspaceDir 抛错。
  useSettingsStore().workspaceDir = "/home/test";
  const wrapper = mount(Harness, { global: { plugins: [pinia, i18n] } });
  return { pinia, wrapper };
}

function providerButton(wrapper: VueWrapper, id: string) {
  const button = wrapper.find(`[data-testid="acp-provider-button"][data-provider-id="${id}"]`);
  if (button.exists()) return button;
  const overflow = wrapper.find(`[data-testid="acp-overflow-item"][data-provider-id="${id}"]`);
  expect(overflow.exists(), `${id} 应出现在主轨道或溢出菜单`).toBe(true);
  return overflow;
}

function openCodeButton(wrapper: VueWrapper) {
  return providerButton(wrapper, "opencode");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isAvailable.mockImplementation(() => true);
  h.homeDir.mockImplementation(() => Promise.resolve("/home/test"));
  h.listener = null;
});

describe("AgentProviderBar · ACP 会话配置选择器", () => {
  it("首屏只显示图标；点击后仅当前 ACP 展开名称", async () => {
    const { wrapper } = mountBar();
    expect(wrapper.text()).toContain("ACP 选择");
    expect(openCodeButton(wrapper).text()).not.toContain("OpenCode");

    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue(options(true));
    await openCodeButton(wrapper).trigger("click");
    await vi.waitFor(() => expect(openCodeButton(wrapper).text()).toContain("OpenCode"));

    const codex = providerButton(wrapper, "codex");
    expect(codex.text()).not.toContain("Codex");
    await codex.trigger("click");
    await vi.waitFor(() => expect(providerButton(wrapper, "codex").text()).toContain("Codex"));
    expect(openCodeButton(wrapper).text()).not.toContain("OpenCode");
  });

  it("收起图标提供名称提示，并只请求 Lobe 实际提供的图标变体", () => {
    const { wrapper } = mountBar();
    const openCode = openCodeButton(wrapper);
    expect(openCode.attributes("title")).toBe("OpenCode");
    expect(wrapper.findAll('[data-testid="acp-provider-tooltip"]').some((tooltip) => tooltip.text() === "OpenCode")).toBe(true);
    const brand = openCode.get('[data-testid="agent-brand-icon"]');
    expect(brand.attributes("src")).toContain("@lobehub/icons-static-svg@latest/icons/opencode.svg");
    expect(brand.attributes("src")).not.toContain("opencode-color.svg");
  });
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

  it("多余 ACP 收入省略菜单，从菜单选择后回到主轨道并展开", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue(options(true));
    const { wrapper } = mountBar();
    const agentStore = useAgentStore();

    const overflowToggle = wrapper.get('[data-testid="acp-overflow-toggle"]');
    expect(overflowToggle.attributes("aria-label")).toBe("更多 ACP");
    await overflowToggle.trigger("click");
    const overflowItems = wrapper.findAll('[data-testid="acp-overflow-item"]');
    expect(overflowItems.length).toBeGreaterThan(0);

    const target = overflowItems.at(-1)!;
    const targetId = target.attributes("data-provider-id")!;
    const targetName = agentStore.agentProviders.find((provider) => provider.id === targetId)!.name;
    await target.trigger("click");
    await vi.waitFor(() => expect(agentStore.selectedProviderId).toBe(targetId));
    expect(wrapper.find('[data-testid="acp-overflow-menu"]').exists()).toBe(false);
    expect(providerButton(wrapper, targetId).text()).toContain(targetName);
  });

  it("未启用 ACP 可一步选择并启用", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue(options(true));
    const { wrapper } = mountBar();
    const agentStore = useAgentStore();

    await providerButton(wrapper, "codex").trigger("click");
    await vi.waitFor(() => expect(agentStore.acpConnected).toBe(true));
    expect(agentStore.agentProviders.find((provider) => provider.id === "codex")?.enabled).toBe(true);
    expect(h.startAgent).toHaveBeenCalledWith("npx -y @agentclientprotocol/codex-acp", expect.any(String));
  });
});

describe("AgentProviderBar · 安装状态探测与胶囊标注", () => {
  /** 模拟桌面运行时（__TAURI_INTERNALS__ 注入 → isTauriRuntime()=true → agentsBackend.detect 走 invoke）。 */
  beforeEach(() => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("挂载即触发本机 CLI 安装探测（桌面态），不需要先去设置页", async () => {
    h.invoke.mockImplementation((cmd: string) => (cmd === "acp_detect_programs" ? Promise.resolve([]) : Promise.resolve()));
    mountBar();
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledWith("acp_detect_programs", expect.any(Object)));
  });

  it("探测结果进入图标提示；展开项只显示名称与状态点", async () => {
    h.invoke.mockImplementation((cmd: string) =>
      cmd === "acp_detect_programs"
        ? Promise.resolve([
            { program: "opencode", installed: true, path: "/usr/local/bin/opencode" },
            { program: "gemini", installed: false, path: null },
            { program: "codex", installed: false, path: null },
          ])
        : Promise.resolve(),
    );
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue(options(true));
    const { wrapper } = mountBar();

    await vi.waitFor(() => expect(openCodeButton(wrapper).attributes("title")).toContain("已安装"));
    expect(openCodeButton(wrapper).text()).not.toContain("已安装");
    expect(providerButton(wrapper, "codex").attributes("title")).toContain("首次启动下载");
    await wrapper.get('[data-testid="acp-overflow-toggle"]').trigger("click");
    expect(providerButton(wrapper, "gemini").attributes("title")).toContain("未安装");
  });
});
