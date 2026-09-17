// 对话页斜杠命令契约：/ 触发菜单、键盘选择（模板 / 开关 / ACP 命令）、无匹配时原样发送、Esc 关闭。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { Attachment } from "@/types";

const h = vi.hoisted(() => ({
  startAgent: vi.fn(),
  openSession: vi.fn(),
  prompt: vi.fn(),
  stop: vi.fn(),
  respondPermission: vi.fn(),
  isAvailable: vi.fn(() => true),
  homeDir: vi.fn<() => Promise<string | null>>(() => Promise.resolve("/home/test")),
}));

vi.mock("@/state/attachment-library", () => ({
  pickAttachments: () => Promise.resolve([] as Attachment[]),
  attachmentsFromFiles: () => Promise.resolve([] as Attachment[]),
  attachmentsFromPaths: () => Promise.resolve([] as Attachment[]),
  attachmentsFromClipboard: () => Promise.resolve([]),
  materializeAttachments: (_sessionId: string, items: readonly Attachment[]) => Promise.resolve([...items]),
  readAttachmentBase64: () => Promise.resolve("QUJD"),
  readAttachmentText: () => Promise.resolve({ text: "x", truncated: false }),
  attachmentObjectUrl: () => Promise.resolve(null),
  releaseAttachmentObjectUrls: () => undefined,
}));

vi.mock("@greywork/acp", () => ({
  createAcpClient: () => ({
    isAvailable: () => h.isAvailable(),
    startAgent: () => h.startAgent(),
    openSession: () => h.openSession(),
    setSessionConfig: () => Promise.resolve([]),
    setPermissionTier: () => Promise.resolve(),
    prompt: () => h.prompt(),
    stop: () => h.stop(),
    respondPermission: () => h.respondPermission(),
    onEvent: () => Promise.resolve(() => undefined),
  }),
  desktopHomeDir: () => h.homeDir(),
}));

import ConversationView from "@/features/conversation/ConversationView.vue";
import { createAppRouter } from "@/router";
import { i18n } from "@/i18n";
import { useAgentStore } from "@/stores/agent";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";

async function mountConversation() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const sessionStore = useSessionStore();
  const session = sessionStore.createSession(null, "斜杠命令测试");
  const router = createAppRouter();
  await router.push(`/conversation/${session.id}`);
  await router.isReady();
  const wrapper = mount(ConversationView, { global: { plugins: [pinia, i18n, router] } });
  return { session, sessionStore, wrapper };
}

function composer(wrapper: Awaited<ReturnType<typeof mountConversation>>["wrapper"]) {
  return wrapper.get('textarea[aria-label="发送消息"]');
}

/** 草稿当前值（VTU 的 element 是 Element，取值需收窄到 textarea）。 */
function composerValue(wrapper: Awaited<ReturnType<typeof mountConversation>>["wrapper"]): string {
  return (composer(wrapper).element as HTMLTextAreaElement).value;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isAvailable.mockImplementation(() => true);
  h.homeDir.mockImplementation(() => Promise.resolve("/home/test"));
  h.startAgent.mockResolvedValue(7);
  h.openSession.mockResolvedValue({ sessionId: "s1", configOptions: [] });
  h.prompt.mockResolvedValue({ turnId: 1 });
  h.stop.mockResolvedValue(undefined);
});

describe("ConversationView · 斜杠命令", () => {
  it("输入 / 弹出内置命令菜单，选中模板命令回填草稿并关闭菜单", async () => {
    const { wrapper } = await mountConversation();
    await composer(wrapper).setValue("/");
    expect(wrapper.find('[data-testid="slash-menu"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="slash-option"]')).toHaveLength(7);

    await composer(wrapper).setValue("/test");
    await composer(wrapper).trigger("keydown", { key: "Enter" });

    expect(composerValue(wrapper)).toBe(i18n.global.t("chat.commands.test.template"));
    expect(wrapper.find('[data-testid="slash-menu"]').exists()).toBe(false);
  });

  it("方向键切换高亮，Enter 触发内置开关并显示状态胶囊", async () => {
    const { wrapper } = await mountConversation();
    const chat = useChatStore();
    await composer(wrapper).setValue("/");
    // 首项是 plan，下一项是 speed
    await composer(wrapper).trigger("keydown", { key: "ArrowDown" });
    await composer(wrapper).trigger("keydown", { key: "Enter" });

    expect(chat.speedBoost).toBe(true);
    expect(composerValue(wrapper)).toBe("");
    expect(wrapper.find('[data-testid="composer-speed-chip"]').exists()).toBe(true);

    await wrapper.get('[data-testid="composer-speed-chip"]').trigger("click");
    expect(chat.speedBoost).toBe(false);
  });

  it("无匹配命令时 Enter 不消费，/zzz 按普通消息发送", async () => {
    const { wrapper } = await mountConversation();
    const chat = useChatStore();
    const submit = vi.spyOn(chat, "submitText");

    await composer(wrapper).setValue("/zzz");
    await composer(wrapper).trigger("keydown", { key: "Enter" });

    expect(submit).toHaveBeenCalledWith("/zzz", []);
    chat.clearSim();
  });

  it("Esc 关闭菜单后继续输入不弹回，离开斜杠形态再输入可重开", async () => {
    const { wrapper } = await mountConversation();
    await composer(wrapper).setValue("/");
    await composer(wrapper).trigger("keydown", { key: "Escape" });
    expect(wrapper.find('[data-testid="slash-menu"]').exists()).toBe(false);

    await composer(wrapper).setValue("/pl");
    expect(wrapper.find('[data-testid="slash-menu"]').exists()).toBe(false);

    await composer(wrapper).setValue("x");
    await composer(wrapper).setValue("/");
    expect(wrapper.find('[data-testid="slash-menu"]').exists()).toBe(true);
  });

  it("ACP 无参命令选中即发（走 dispatchToAcp），带参命令插入等待补参数", async () => {
    const { wrapper } = await mountConversation();
    const agent = useAgentStore();
    const dispatch = vi.spyOn(agent, "dispatchToAcp").mockResolvedValue(undefined);
    agent.routeToAcp = true;
    agent.acpCommands = [
      { name: "compact", description: "压缩上下文" },
      { name: "deploy", description: "部署", input: { hint: "环境名" } },
    ];

    await composer(wrapper).setValue("/compact");
    await composer(wrapper).trigger("keydown", { key: "Enter" });
    expect(dispatch).toHaveBeenCalledWith("/compact", []);
    expect(composerValue(wrapper)).toBe("");

    await composer(wrapper).setValue("/deploy");
    await composer(wrapper).trigger("keydown", { key: "Enter" });
    expect(composerValue(wrapper)).toBe("/deploy ");
    expect(dispatch).toHaveBeenCalledTimes(1);

    useChatStore().clearSim();
  });

  it("ACP 命令只在 ACP 路由下出现", async () => {
    const { wrapper } = await mountConversation();
    const agent = useAgentStore();
    agent.acpCommands = [{ name: "compact", description: "压缩上下文" }];

    await composer(wrapper).setValue("/com");
    expect(wrapper.findAll('[data-testid="slash-option"]')).toHaveLength(0);
  });

  it("计划模式胶囊随 /plan 选中出现，可点击关闭", async () => {
    const { wrapper } = await mountConversation();
    const settings = useSettingsStore();
    await composer(wrapper).setValue("/plan");
    await composer(wrapper).trigger("keydown", { key: "Enter" });

    expect(settings.planMode).toBe(true);
    expect(wrapper.find('[data-testid="composer-plan-chip"]').exists()).toBe(true);
    await wrapper.get('[data-testid="composer-plan-chip"]').trigger("click");
    expect(settings.planMode).toBe(false);
  });
});
