// 后端选择条渲染契约：点击 ACP 胶囊 → 同处展开会话配置选择器（模型 / 思考强度 / 会话模式，
// 取决于 agent 在 session/new 暴露的 select 型配置）；模型未暴露思考强度时展示提示桩；
// 连接失败就地展示错误文案并可点击重试；已连接重复点击不再重复建会话。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent } from "vue";
import { createPinia, setActivePinia } from "pinia";
import AcpSessionConfig from "@/features/conversation/AcpSessionConfig.vue";
import { i18n } from "@/i18n";
import AgentProviderBar from "@/features/conversation/AgentProviderBar.vue";
import { localReasoningOverride } from "@/stores/chat-llm";
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

/** 「…」菜单已改为 shadcn DropdownMenu，内容 Portal 到 body：wrapper.find 够不到。 */
function overflowItems(): DOMWrapper<Element>[] {
  return [...document.body.querySelectorAll('[data-testid="acp-overflow-item"]')].map((element) => new DOMWrapper(element));
}

function overflowMenuExists(): boolean {
  return document.body.querySelector('[data-testid="acp-overflow-menu"]') !== null;
}

/** 提示内容 Portal 到 body 且只在触发时挂载 —— 所以要先把触发器聚焦。
 *  注意该节点的 textContent 会把 reka 那个 1px 隐藏测量副本也算进来（文本出现两遍），
 *  所以断言一律用 toContain，不要用 toBe 精确比对。 */
function tooltipText(): string {
  return document.body.querySelector('[data-slot="tooltip-content"]')?.textContent?.trim() ?? "";
}

afterEach(() => {
  document.body.innerHTML = "";
});

function providerButton(wrapper: VueWrapper, id: string) {
  const button = wrapper.find(`[data-testid="acp-provider-button"][data-provider-id="${id}"]`);
  if (button.exists()) return button;
  const overflow = overflowItems().find((item) => item.attributes("data-provider-id") === id);
  expect(overflow, `${id} 应出现在主轨道或溢出菜单`).toBeDefined();
  return overflow!;
}

function openCodeButton(wrapper: VueWrapper) {
  return providerButton(wrapper, "opencode");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isAvailable.mockImplementation(() => true);
  h.homeDir.mockImplementation(() => Promise.resolve("/home/test"));
  h.listener = null;
  // 模块级会话覆盖是全局单例：用例间必须复位，否则上一用例的覆盖会漏进下一用例
  localReasoningOverride.value = null;
  // settings 会持久化 selectedModelProviderId 等：不清理会跨用例水合出前置状态
  localStorage.clear();
});

describe("AgentProviderBar · Local 模型 / 思考强度选择器", () => {
  it("点 Local 展开选择区：模型下拉与思考强度胶囊出现；ACP 展开时不出现", async () => {
    const { wrapper } = mountBar();
    expect(wrapper.find('[data-testid="local-selector"]').exists()).toBe(false);

    await wrapper.get('[data-testid="local-provider-button"]').trigger("click");
    await flushPromises();
    const selector = wrapper.find('[data-testid="local-selector"]');
    expect(selector.exists()).toBe(true);
    // 默认供应商的模型名出现在触发按钮上
    expect(selector.text()).toContain(useSettingsStore().modelProviders[0].model);

    // 切到 ACP 后 Local 选择区收起
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue(options(true));
    await openCodeButton(wrapper).trigger("click");
    await vi.waitFor(() => expect(useAgentStore().acpConnected).toBe(true));
    expect(wrapper.find('[data-testid="local-selector"]').exists()).toBe(false);
  });

  it("模型下拉选择即切换全局默认供应商", async () => {
    const { wrapper } = mountBar();
    const settings = useSettingsStore();
    const second = settings.modelProviders[1] ?? settings.modelProviders[0];
    await wrapper.get('[data-testid="local-provider-button"]').trigger("click");
    await flushPromises();

    await wrapper.get('[data-testid="local-model-button"]').trigger("click");
    await flushPromises();
    const items = [...document.body.querySelectorAll('[data-testid="local-model-item"]')].map((element) => new DOMWrapper(element));
    expect(items.length).toBeGreaterThan(0);
    await items.at(-1)!.trigger("click");
    await flushPromises();
    expect(settings.selectedModelProviderId).toBe(second.id);
  });

  it("思考强度胶囊写会话覆盖并影响生效档；设为默认写回供应商并清覆盖", async () => {
    const { wrapper } = mountBar();
    const settings = useSettingsStore();
    // 镜像组件的实际选择：选中项（若可用）优先，否则第一个可用
    const available = settings.modelProviders.filter(
      (candidate) => candidate.enabled && !!candidate.baseUrl?.trim() && !!candidate.model.trim(),
    );
    const target = available.find((candidate) => candidate.id === settings.selectedModelProviderId) ?? available[0];
    await wrapper.get('[data-testid="local-provider-button"]').trigger("click");
    await flushPromises();

    const high = wrapper.get('[data-testid="local-effort-chip"][data-effort="high"]');
    await high.trigger("click");
    expect(localReasoningOverride.value).toBe("high");

    await wrapper.get('[data-testid="local-effort-default"]').trigger("click");
    expect(localReasoningOverride.value).toBeNull();
    expect(settings.modelProviders.find((candidate) => candidate.id === target.id)?.reasoningEffort).toBe("high");
  });
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

  it("收起图标提供名称提示（已换成 Hint），并只引用随包发出的 mono 变体", async () => {
    const { wrapper } = mountBar();
    const openCode = openCodeButton(wrapper);

    // 原生 title 已移除：提示改由 Hint 提供，聚焦也能出、读屏也念得到。
    expect(openCode.attributes("title")).toBeUndefined();
    await openCode.trigger("focus");
    await flushPromises();
    // 未探测到安装状态时提示只有名字，不带「· 状态」后缀。
    expect(tooltipText()).toContain("OpenCode");
    expect(tooltipText()).not.toContain("·");

    const brand = openCode.get('[data-testid="agent-brand-icon"]');
    // 品牌图标是仓内资源：打包版 CSP 只放行 'self'，外链图会被拦成空白。
    // 小 SVG 由 vite 内联成 data: URI（data: 在 CSP 白名单里），大文件才落成同源路径。
    const src = brand.attributes("src") ?? "";
    expect(src).not.toMatch(/^https?:\/\//);
    expect(src).toContain("opencode");
    expect(src).not.toContain("opencode-color");
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
    await flushPromises();
    const items = overflowItems();
    expect(items.length).toBeGreaterThan(0);

    const target = items.at(-1)!;
    const targetId = target.attributes("data-provider-id")!;
    const targetName = agentStore.agentProviders.find((provider) => provider.id === targetId)!.name;
    await target.trigger("click");
    await vi.waitFor(() => expect(agentStore.selectedProviderId).toBe(targetId));
    expect(overflowMenuExists()).toBe(false);
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

    // 轨道图标：安装状态进提示（不再是 title 属性）。
    await openCodeButton(wrapper).trigger("focus");
    await vi.waitFor(() => expect(tooltipText()).toContain("已安装"));
    expect(openCodeButton(wrapper).text()).not.toContain("已安装");

    await openCodeButton(wrapper).trigger("blur");
    await providerButton(wrapper, "codex").trigger("focus");
    await vi.waitFor(() => expect(tooltipText()).toContain("首次启动下载"));

    // 溢出的项：安装状态直接写在菜单项里，不再需要提示。
    await wrapper.get('[data-testid="acp-overflow-toggle"]').trigger("click");
    await flushPromises();
    const gemini = overflowItems().find((item) => item.attributes("data-provider-id") === "gemini");
    expect(gemini?.text()).toContain("未安装");
  });
});
