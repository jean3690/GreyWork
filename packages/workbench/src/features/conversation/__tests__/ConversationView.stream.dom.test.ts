// ACP 回合的可见阶段契约：发送后（首个产出到达前）显示「正在思考…」占位；
// 思考增量到达 → 该段 ThinkingBlock 以「思考过程」标题自动展开可见推理；
// 正文首 chunk 到达 → 该段收起为「已思考 Ns」细条，正文流式显示。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ConversationView from "@/features/conversation/ConversationView.vue";
import { createAppRouter } from "@/router";
import { i18n } from "@/i18n";
import { useAgentStore } from "@/stores/agent";
import { useSessionStore } from "@/stores/session";
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

function emit(event: { kind: string; payload: unknown }): void {
  expect(h.listener, "事件监听应已挂载").not.toBeNull();
  h.listener?.(event);
}

async function mountConversation() {
  const pinia = createPinia();
  setActivePinia(pinia);
  // ACP 建会话要解析工作区：happy-dom 非 Tauri 运行时，设置项为空则 resolveWorkspaceDir 抛错。
  useSettingsStore().workspaceDir = "/home/test";
  const sessionStore = useSessionStore();
  const session = sessionStore.createSession(null, "测试会话");
  const router = createAppRouter();
  await router.push(`/conversation/${session.id}`);
  await router.isReady();
  const wrapper = mount(ConversationView, { global: { plugins: [pinia, i18n, router] } });
  return { pinia, router, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isAvailable.mockImplementation(() => true);
  h.homeDir.mockImplementation(() => Promise.resolve("/home/test"));
  h.listener = null;
});

describe("ConversationView · ACP 回合阶段可见性", () => {
  it("发送后依次呈现：思考占位 → 思考展开 → 正文流式（思考收起）", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({
      sessionId: "s1",
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "opencode/big-pickle",
          options: [{ value: "opencode/big-pickle", name: "big-pickle" }],
        },
      ],
    });
    h.prompt.mockResolvedValue({ turnId: 42 });
    const { wrapper } = await mountConversation();
    const agentStore = useAgentStore();
    await agentStore.activateAcpProvider("opencode");
    expect(agentStore.acpConnected).toBe(true);
    expect(agentStore.routeToAcp).toBe(true);

    agentStore.dispatchToAcp("你好");
    // 阶段一：正文与思考都未开始 → 「正在思考…」占位 + 底栏「处理中…」
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("正在思考…");
      expect(wrapper.text()).toContain("处理中…");
    });

    // 阶段二：思考增量到达 → 占位消失、当前思考段自动展开可见推理
    emit({ kind: "thought", payload: { text: "先拆解一下需求，" } });
    emit({ kind: "thought", payload: { text: "再给答复。" } });
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("思考过程");
      expect(wrapper.text()).toContain("先拆解一下需求，再给答复。");
    });

    // 阶段三：正文 chunk 到达 → 思考自动收起（正文区替换），流式显示正文
    emit({
      kind: "session-update",
      payload: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "好的，我" } },
      },
    });
    emit({
      kind: "session-update",
      payload: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "来回答你。" } },
      },
    });
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("好的，我来回答你。");
      expect(wrapper.text()).not.toContain("先拆解一下需求");
    });
    expect(wrapper.text()).toContain("已思考"); // 仍保留「已思考 Ns」折叠条
  });
});
