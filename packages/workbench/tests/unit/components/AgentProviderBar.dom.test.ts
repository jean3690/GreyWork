// 后端选择条渲染契约：点击 ACP 胶囊 → 同处展开会话配置选择器（模型 / 思考强度 / 会话模式，
// 取决于 agent 在 session/new 暴露的 select 型配置）；模型未暴露思考强度时展示提示桩；
// 连接失败就地展示错误文案并可点击重试；已连接重复点击不再重复建会话。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("选择条列出全部 ACP 后端（不止已启用），未启用的可一步选到并启用", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue(options(true));
    const { wrapper } = mountBar();
    const agentStore = useAgentStore();

    // 预设里除 opencode 外默认禁用，但都应出现在条上（用户提供「其他 ACP 选择」）。
    const codex = wrapper.findAll("button").find((button) => button.text().includes("Codex"));
    expect(codex, "Codex 胶囊应出现在选择条").toBeDefined();

    // 点击未启用的 Codex：先启用再建会话（选择即启用）。
    await codex!.trigger("click");
    await vi.waitFor(() => expect(agentStore.acpConnected).toBe(true));
    expect(agentStore.agentProviders.find((p) => p.id === "codex")?.enabled).toBe(true);
    // 连接命令应为 codex 的启动命令（证明选中的是 Codex 而非 OpenCode）。
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

  it("探测命中：已装后端显「已安装」，npx 型未装显「首次启动下载」，原生未装显「未安装」", async () => {
    // opencode 已装；codex（npx 适配器）未装 → 首次启动下载；gemini（原生二进制）未装 → 未安装。
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
    await vi.waitFor(() => expect(wrapper.text()).toContain("已安装"));

    const opencode = wrapper.findAll("button").find((button) => button.text().includes("OpenCode"));
    expect(opencode!.text()).toContain("已安装");

    // codex 走官方 npx 适配器：未装时明示「首次启动下载」而非「未安装」。
    const codex = wrapper.findAll("button").find((button) => button.text().includes("Codex"));
    expect(codex!.text()).toContain("首次启动下载");
    expect(codex!.text()).not.toContain("未安装");

    // gemini 原生二进制（gemini --acp）：未装时显「未安装」。
    const gemini = wrapper.findAll("button").find((button) => button.text().includes("Gemini"));
    expect(gemini!.text()).toContain("未安装");
  });
});
