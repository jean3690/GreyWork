// 后端选择条渲染契约：点击 ACP 胶囊 → 同处展开会话配置选择器（模型 / 思考强度 / 会话模式，
// 取决于 agent 在 session/new 暴露的 select 型配置）；模型未暴露思考强度时展示提示桩；
// 连接失败就地展示错误文案并可点击重试；已连接重复点击不再重复建会话。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, enableAutoUnmount, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import AcpSessionConfig from "@/features/conversation/AcpSessionConfig.vue";
import { i18n } from "@/i18n";
import AgentProviderBar from "@/features/conversation/AgentProviderBar.vue";
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

vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal()),
  invoke: (...args: unknown[]) => (h.invoke as (...a: unknown[]) => Promise<unknown>)(...args),
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

/**
 * 用例结束后**卸载**挂载的组件树。
 *
 * 之前是 `document.body.innerHTML = ""` 一把清空：DOM 被抽走而组件树还活着，tooltip
 * （delayDuration=300ms）那类延时回调一落地就 patch 到已消失的容器上，抛
 * `Cannot read properties of null (reading 'insertBefore')` —— 用例本身仍是绿的，
 * 但它以 unhandled rejection 的形式让整轮 `pnpm -r test` 退出码变 1。
 *
 * 不能再顺手清 body：手工清空之后再卸载，Vue 会在 unmount 里找不到兄弟节点而抛错
 * （`nextSibling` null）。卸载本身就干净地移除了挂到 body 上的挂载点。
 */
enableAutoUnmount(afterEach);

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

/**
 * 预设里默认只开 opencode；而 `DEFAULT_AGENT_PROVIDERS` 是模块级对象，启停会**原地改写**它，
 * 同文件后面的用例会读到残留状态。这里显式把整份目录重置成给定集合，保证用例互不影响。
 * 服务端态还要先等目录接管完成，免得随后的预设重建把改动覆盖掉。
 */
async function setEnabledProviders(...ids: string[]): Promise<void> {
  const store = useAgentStore();
  await store.providersHydrated;
  for (const provider of store.agentProviders) {
    await store.setAgentProviderEnabled(provider.id, ids.includes(provider.id));
  }
  await nextTick();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isAvailable.mockImplementation(() => true);
  h.homeDir.mockImplementation(() => Promise.resolve("/home/test"));
  h.listener = null;
  // settings 会持久化 selectedModelProviderId 等：不清理会跨用例水合出前置状态
  localStorage.clear();
});

describe("AgentProviderBar · ACP 会话配置选择器", () => {
  it("首屏只显示图标；点击后仅当前 ACP 展开名称", async () => {
    const { wrapper } = mountBar();
    await setEnabledProviders("opencode", "codex");
    expect(wrapper.text()).toContain("ACP 选择");
    // 名字常驻 DOM（收起态是靠 grid 0fr 把宽度收成 0），所以「有没有展开」看 data-expanded，
    // 不能再用 text() 判断 —— 那已经恒为真。
    expect(openCodeButton(wrapper).text()).toContain("OpenCode");
    expect(openCodeButton(wrapper).attributes("data-expanded")).toBe("false");

    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue(options(true));
    await openCodeButton(wrapper).trigger("click");
    await vi.waitFor(() => expect(openCodeButton(wrapper).attributes("data-expanded")).toBe("true"));

    const codex = providerButton(wrapper, "codex");
    expect(codex.attributes("data-expanded")).toBe("false");
    await codex.trigger("click");
    await vi.waitFor(() => expect(providerButton(wrapper, "codex").attributes("data-expanded")).toBe("true"));
    expect(openCodeButton(wrapper).attributes("data-expanded")).toBe("false");
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

  it("只有旧版 modes：模式只出一个选择器，模型位保持只读占位", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({
      sessionId: "session-legacy-modes",
      configOptions: [],
      modes: {
        currentModeId: "build",
        availableModes: [
          { id: "build", name: "Build" },
          { id: "plan", name: "Plan" },
        ],
      },
    });
    const { wrapper } = mountBar();

    await openCodeButton(wrapper).trigger("click");
    await vi.waitFor(() => expect(wrapper.text()).toContain("会话模式 · Build"));
    // 没有 model option 时模型胶囊不应抢走会话模式（否则和额外配置胶囊重复）。
    expect(wrapper.text()).toContain("使用 CLI 模型");
    expect(wrapper.findAll("button").filter((button) => button.text().toLowerCase().includes("build"))).toHaveLength(1);
    expect(wrapper.text()).not.toContain("模型不支持");
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
    // 铺满主轨道并留出溢出项：4 个已启用 → 容量 3，最后一个进「…」。
    await setEnabledProviders("opencode", "codex", "claude-code", "gemini");

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

  it("未启用 ACP 不出现在选择条；启用后才出现并可连接", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue(options(true));
    const { wrapper } = mountBar();
    const agentStore = useAgentStore();

    // 重置成「只开 opencode」：codex 既不在主轨道，也不在溢出菜单。
    await setEnabledProviders("opencode");
    expect(wrapper.find('[data-testid="acp-provider-button"][data-provider-id="codex"]').exists()).toBe(false);
    const overflowToggle = wrapper.find('[data-testid="acp-overflow-toggle"]');
    if (overflowToggle.exists()) {
      await overflowToggle.trigger("click");
      await flushPromises();
    }
    expect(overflowItems().some((item) => item.attributes("data-provider-id") === "codex")).toBe(false);

    // 在设置里启用后才出现在主轨道，点击即连接。
    await agentStore.setAgentProviderEnabled("codex", true);
    await nextTick();
    expect(agentStore.agentProviders.find((provider) => provider.id === "codex")?.enabled).toBe(true);

    await providerButton(wrapper, "codex").trigger("click");
    await vi.waitFor(() => expect(agentStore.acpConnected).toBe(true));
    expect(h.startAgent).toHaveBeenCalledWith("npx -y @agentclientprotocol/codex-acp", expect.any(String));
  });
});

describe("AgentProviderBar · 安装状态探测与胶囊标注", () => {
  /** 模拟服务端运行时（__GREYWORK_RUNTIME__="server" → agentsBackend.detect 走 invoke）。 */
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__GREYWORK_RUNTIME__ = "server";
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__GREYWORK_RUNTIME__;
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
    // codex 留在主轨道、gemini 挤进溢出菜单，两种状态都要能标注。
    await setEnabledProviders("opencode", "codex", "claude-code", "gemini");

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

/**
 * 停用即隐藏：设置里取消勾选的后端会从选择条消失（服务端只读态一样 ——
 * 选择条不再有「点一下顺手启用」这条路径，启用统一收口到设置页）。
 */
describe("AgentProviderBar · 停用的后端从选择条消失", () => {
  /** 假服务端：/api/commands 回 available:false，/api/command 一律成功返回 null。 */
  function installServerFetch(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        void init;
        const url = String(input);
        if (url.endsWith("/api/commands")) {
          return new Response(
            JSON.stringify([{ name: "db_agents_sync", auth: "required", desktopOnly: false, binary: false, available: false }]),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify(null), { status: 200 });
      }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as Record<string, unknown>).__GREYWORK_RUNTIME__;
  });

  it("停用 opencode 后它不再出现在选择条，并提示去设置启用", async () => {
    // 直接设属性而不是 stubGlobal("window", …)：整个换掉 window 会丢掉
    // trigger() 依赖的 Event/MouseEvent 构造器。
    (window as unknown as Record<string, unknown>).__GREYWORK_RUNTIME__ = "server";
    installServerFetch();
    const { wrapper } = mountBar();
    const store = useAgentStore();

    // 先把目录重置成「只开 opencode」，再停用它：确保验的是「停用即隐藏」而非残留状态。
    await setEnabledProviders("opencode");
    await store.setAgentProviderEnabled("opencode", false);
    await nextTick();

    expect(store.agentProviders.find((provider) => provider.id === "opencode")?.enabled).toBe(false);
    expect(wrapper.find('[data-testid="acp-provider-button"][data-provider-id="opencode"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("未启用任何 ACP 后端");
  });
});
