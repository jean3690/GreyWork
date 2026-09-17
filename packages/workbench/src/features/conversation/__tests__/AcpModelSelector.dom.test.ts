// 模型选择面板契约：长列表带搜索过滤 + 限高滚动；短列表不出现搜索框；
// 选中项经 setSessionConfig 切换并关闭；Esc 关闭。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import AcpModelSelector from "@/features/conversation/AcpModelSelector.vue";
import { useAgentStore } from "@/stores/agent";
import { useSettingsStore } from "@/stores/settings";

const h = vi.hoisted(() => ({
  startAgent: vi.fn(),
  openSession: vi.fn(),
  setSessionConfig: vi.fn(),
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
      setPermissionTier: () => Promise.resolve(),
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

function modelOptions(count: number, extra: { value: string; name: string }[] = []) {
  const options = Array.from({ length: count }, (_, i) => ({
    value: `opencode/mock-${i + 1}`,
    name: `Mock Model ${i + 1}`,
  }));
  // mock-1 在前作为 currentValue；候选目标追加在尾部
  return [...options, ...extra];
}

async function activateWith(options: { value: string; name: string }[]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  // ACP 建会话要解析工作区：happy-dom 非 Tauri 运行时，设置项为空则 resolveWorkspaceDir 抛错。
  useSettingsStore().workspaceDir = "/home/test";
  h.startAgent.mockResolvedValue(7);
  h.openSession.mockResolvedValue({
    sessionId: "s1",
    configOptions: [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: options[0]?.value,
        options,
      },
    ],
  });
  const agentStore = useAgentStore();
  await agentStore.activateAcpProvider("opencode");
  const wrapper = mount(AcpModelSelector, {
    props: { optionId: "model", placeholder: "Use CLI model", icon: "magic" },
    global: { plugins: [pinia] },
  });
  return { agentStore, wrapper };
}

function pill(wrapper: ReturnType<typeof mount>) {
  const button = wrapper.find("button[aria-haspopup]");
  expect(button.exists()).toBe(true);
  return button;
}
function menuItems(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('button[role="menuitemradio"]');
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isAvailable.mockImplementation(() => true);
  h.homeDir.mockImplementation(() => Promise.resolve("/home/test"));
  h.listener = null;
  h.setSessionConfig.mockResolvedValue([]);
});

describe("AcpModelSelector · 长列表搜索", () => {
  it("≥12 项时出现搜索框；输入过滤后仅剩匹配项，可点选并走 setSessionConfig", async () => {
    const target = { value: "agentrouter/gpt-5.6-sol", name: "AgentRouter GPT-5.6 Sol" };
    const { wrapper } = await activateWith(modelOptions(19, [target]));

    await pill(wrapper).trigger("click");
    const input = wrapper.find('input[aria-label="搜索Model"]');
    expect(input.exists()).toBe(true);
    expect(menuItems(wrapper).length).toBe(20);

    await input.setValue("gpt-5.6");
    const visible = menuItems(wrapper);
    expect(visible.length).toBe(1);
    expect(visible.at(0)?.text()).toContain("GPT-5.6");

    await visible.at(0)?.trigger("click");
    expect(h.setSessionConfig).toHaveBeenCalledWith(7, "model", "agentrouter/gpt-5.6-sol");
    await vi.waitFor(() => expect(pill(wrapper).attributes("aria-expanded")).toBe("false"));
  });

  it("Esc 关闭面板", async () => {
    const { wrapper } = await activateWith(modelOptions(20));
    await pill(wrapper).trigger("click");
    expect(pill(wrapper).attributes("aria-expanded")).toBe("true");
    await wrapper.find('input[aria-label="搜索Model"]').trigger("keydown", { key: "Escape" });
    expect(pill(wrapper).attributes("aria-expanded")).toBe("false");
  });

  it("无匹配时给出空态提示", async () => {
    const { wrapper } = await activateWith(modelOptions(20));
    await pill(wrapper).trigger("click");
    await wrapper.find('input[aria-label="搜索Model"]').setValue("zzz-none");
    expect(menuItems(wrapper).length).toBe(0);
    expect(wrapper.text()).toContain("无匹配选项");
  });
});

describe("AcpModelSelector · 短列表轻量面板", () => {
  it("<12 项不出现搜索框，直接平铺", async () => {
    const { wrapper } = await activateWith(modelOptions(3));
    await pill(wrapper).trigger("click");
    expect(wrapper.find('input[aria-label="搜索Model"]').exists()).toBe(false);
    expect(menuItems(wrapper).length).toBe(3);
  });
});

describe("AcpModelSelector · 面板方向", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("触发器贴近视口底部 → 面板向上弹（bottom-full），可正常点选", async () => {
    const rect = { left: 400, top: 706, right: 640, bottom: 730, width: 240, height: 24, x: 400, y: 706, toJSON: () => ({}) };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect as DOMRect);
    const { wrapper } = await activateWith(modelOptions(20));
    await pill(wrapper).trigger("click");
    expect(wrapper.find("div.bottom-full").exists()).toBe(true);
    // 面板在触发器上方且选项仍可达
    expect(menuItems(wrapper).length).toBe(20);
    await menuItems(wrapper).at(5)?.trigger("click");
    await vi.waitFor(() => expect(pill(wrapper).attributes("aria-expanded")).toBe("false"));
  });
});
