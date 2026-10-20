// 消息行动作的编排契约（A）：编辑后重发 / 重新生成 / 删除。
// 三者共用 prepareResend 原语（工作区硬恢复 + 截流 + 清 ACP 绑定），差别只在截完之后干什么：
// 重发按编辑后的文本派发、重生成按原输入派发、删除不派发只截流。
// 宿主经 host-ipc 的 invoke 打桩；ACP 客户端照 stream 测试的套路打桩。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
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

const T = 1_700_000_000_000;

/** 起一条带「旧 user + 旧 assistant」的会话并挂上路由；返回会话记录。 */
async function mountSeeded() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSettingsStore().workspaceDir = "/home/test";
  const sessionStore = useSessionStore();
  const session = sessionStore.createSession(null, "重发测试");
  sessionStore
    .ensure(session.id)
    .push({ id: "u1", role: "user", content: "旧输入", ts: T }, { id: "a1", role: "assistant", content: "旧回复", ts: T + 1000 });
  const router = createAppRouter();
  await router.push(`/conversation/${session.id}`);
  await router.isReady();
  const wrapper = mount(ConversationView, { global: { plugins: [pinia, i18n, router] } });
  const agentStore = useAgentStore();
  await agentStore.activateAcpProvider("opencode");
  h.prompt.mockClear();
  return { wrapper, sessionStore, session, agentStore };
}

/** 确认弹层经 reka portal 挂到 document.body（不在 wrapper 里），按既有测试的套路查。 */
function dialogButton(label: string): HTMLButtonElement {
  const buttons = [...document.body.querySelectorAll<HTMLButtonElement>('[data-slot="alert-dialog-content"] button')];
  const found = buttons.find((button) => button.textContent === label);
  if (!found) throw new Error(`确认弹层里找不到按钮：${label}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isAvailable.mockImplementation(() => true);
  h.homeDir.mockImplementation(() => Promise.resolve("/home/test"));
  h.listener = null;
  h.startAgent.mockResolvedValue(7);
  h.openSession.mockResolvedValue({ sessionId: "s1", configOptions: [] });
  h.prompt.mockResolvedValue({ turnId: 1 });
});

describe("ConversationView · 编辑后重发", () => {
  it("点编辑：草稿回填 + 横幅出现；发送走 prepareResend 后按新文本重派发", async () => {
    const { wrapper, sessionStore, session } = await mountSeeded();

    await wrapper.get('[data-testid="message-edit"]').trigger("click");
    expect(wrapper.find('[data-testid="edit-banner"]').exists()).toBe(true);
    const textarea = wrapper.get("textarea");
    expect((textarea.element as HTMLTextAreaElement).value).toBe("旧输入");

    await textarea.setValue("新输入");
    await wrapper.get('[data-testid="minimal-composer-send"]').trigger("click");
    await vi.waitFor(() => expect(h.prompt).toHaveBeenCalled());

    const list = sessionStore.ensure(session.id);
    // 旧 user + 旧 assistant 被截掉，编辑后的文本作为新 user 入流并重开回合
    expect(list).toHaveLength(2);
    expect(list[0]?.content).toBe("新输入");
    expect(list[0]?.id).not.toBe("u1");
    // 横幅撤下，编辑态收口
    expect(wrapper.find('[data-testid="edit-banner"]').exists()).toBe(false);
  });

  it("取消编辑：草稿保留、横幅撤下，不再走重发链", async () => {
    const { wrapper } = await mountSeeded();

    await wrapper.get('[data-testid="message-edit"]').trigger("click");
    await wrapper.get("textarea").setValue("改了一半");
    await wrapper.get('[data-testid="edit-cancel"]').trigger("click");

    expect(wrapper.find('[data-testid="edit-banner"]').exists()).toBe(false);
    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("改了一半");
    expect(h.prompt).not.toHaveBeenCalled();
  });
});

describe("ConversationView · 重新生成", () => {
  it("回退到回合起点后按原输入重派发（文本不变，消息是新一轮）", async () => {
    const { wrapper, sessionStore, session } = await mountSeeded();

    await wrapper.get('[data-testid="message-regenerate"]').trigger("click");
    await vi.waitFor(() => expect(h.prompt).toHaveBeenCalled());

    const list = sessionStore.ensure(session.id);
    expect(list).toHaveLength(2);
    expect(list[0]?.content).toBe("旧输入");
    expect(list[0]?.id).not.toBe("u1");
  });
});

describe("ConversationView · 删除回复", () => {
  it("确认后只掉这条回复（消息流截断，不重派发、不碰工作区）", async () => {
    const { wrapper, sessionStore, session } = await mountSeeded();

    await wrapper.get('[data-testid="message-delete"]').trigger("click");
    await flushPromises();
    expect(document.body.querySelector('[data-slot="alert-dialog-content"]')?.textContent).toContain("删除这条回复？");

    dialogButton("删除").click();
    await flushPromises();

    const list = sessionStore.ensure(session.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("u1");
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it("取消确认：消息原样留在流里", async () => {
    const { wrapper, sessionStore, session } = await mountSeeded();

    await wrapper.get('[data-testid="message-delete"]').trigger("click");
    await flushPromises();
    dialogButton("取消").click();
    await flushPromises();

    expect(sessionStore.ensure(session.id)).toHaveLength(2);
  });
});
