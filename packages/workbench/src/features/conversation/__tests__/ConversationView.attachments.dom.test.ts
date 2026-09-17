// 输入卡附件链路：选择 / 粘贴 → 托盘 chip → 删除 → 发送时随消息落库并派发。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { Attachment } from "@/types";

const h = vi.hoisted(() => ({
  pickAttachments: vi.fn<() => Promise<Attachment[]>>(),
  attachmentsFromFiles: vi.fn<(files: readonly File[]) => Promise<Attachment[]>>(),
  attachmentsFromPaths: vi.fn<(paths: readonly string[]) => Promise<Attachment[]>>(),
  materializeAttachments: vi.fn<(sessionId: string, items: readonly Attachment[]) => Promise<Attachment[]>>(),
  // ACP 侧（agent store 依赖）
  startAgent: vi.fn(),
  openSession: vi.fn(),
  prompt: vi.fn(),
  stop: vi.fn(),
  respondPermission: vi.fn(),
  isAvailable: vi.fn(() => true),
  homeDir: vi.fn<() => Promise<string | null>>(() => Promise.resolve("/home/test")),
}));

vi.mock("@/state/attachment-library", () => ({
  pickAttachments: () => h.pickAttachments(),
  attachmentsFromFiles: (files: readonly File[]) => h.attachmentsFromFiles(files),
  attachmentsFromPaths: (paths: readonly string[]) => h.attachmentsFromPaths(paths),
  attachmentsFromClipboard: () => Promise.resolve([]),
  materializeAttachments: (sessionId: string, items: readonly Attachment[]) => h.materializeAttachments(sessionId, items),
  readAttachmentBase64: () => Promise.resolve("QUJD"),
  readAttachmentText: () => Promise.resolve({ text: "x", truncated: false }),
  attachmentObjectUrl: (item: Attachment) => Promise.resolve(item.dataUrl ?? null),
  releaseAttachmentObjectUrls: () => undefined,
}));

vi.mock("@greywork/acp", () => ({
  createAcpClient: () => ({
    isAvailable: () => h.isAvailable(),
    startAgent: () => h.startAgent(),
    openSession: () => h.openSession(),
    setSessionConfig: () => Promise.resolve([]),
    setPermissionTier: () => Promise.resolve(),
    prompt: (handle: number, text: string, units?: readonly unknown[]) => h.prompt(handle, text, units),
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

function draft(id: string): Attachment {
  return { id, kind: "image", name: `${id}.png`, mime: "image/png", size: 4, dataUrl: "data:image/png;base64,QUJD" };
}

function stored(item: Attachment): Attachment {
  const { dataUrl: _dataUrl, ...rest } = item;
  return { ...rest, path: `/home/test/.greyWork/attachments/ses-1/${item.id}.png` };
}

async function mountConversation() {
  const pinia = createPinia();
  setActivePinia(pinia);
  // ACP 建会话要解析工作区：happy-dom 非 Tauri 运行时，设置项为空则 resolveWorkspaceDir 抛错。
  useSettingsStore().workspaceDir = "/home/test";
  const sessionStore = useSessionStore();
  const session = sessionStore.createSession(null, "附件测试");
  const router = createAppRouter();
  await router.push(`/conversation/${session.id}`);
  await router.isReady();
  const wrapper = mount(ConversationView, { global: { plugins: [pinia, i18n, router] } });
  return { session, sessionStore, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.pickAttachments.mockImplementation(() => Promise.resolve([]));
  h.attachmentsFromFiles.mockImplementation(() => Promise.resolve([]));
  h.attachmentsFromPaths.mockImplementation(() => Promise.resolve([]));
  h.materializeAttachments.mockImplementation((_sessionId, items) => Promise.resolve(items.map(stored)));
});

describe("ConversationView · 输入卡附件", () => {
  it("选择附件后托盘出 chip，可逐个移除", async () => {
    h.pickAttachments.mockResolvedValue([draft("att-1")]);
    const { wrapper } = await mountConversation();

    expect(wrapper.find('[data-testid="composer-attachments"]').exists()).toBe(false);
    await wrapper.get('[data-testid="composer-attach"]').trigger("click");
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-testid="attachment-chip"]')).toHaveLength(1);
    });
    expect(wrapper.get('[data-testid="attachment-chip"]').attributes("data-attachment-kind")).toBe("image");

    await wrapper.get('[data-testid="attachment-remove"]').trigger("click");
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="composer-attachments"]').exists()).toBe(false);
    });
  });

  it("粘贴图片文件同样进入托盘", async () => {
    h.attachmentsFromFiles.mockResolvedValue([draft("att-2")]);
    const { wrapper } = await mountConversation();
    const file = new File(["x"], "shot.png", { type: "image/png" });

    await wrapper.get('textarea[aria-label="发送消息"]').trigger("paste", { clipboardData: { files: [file] } });
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-testid="attachment-chip"]')).toHaveLength(1);
    });
    expect(h.attachmentsFromFiles.mock.calls[0][0]).toEqual([file]);
  });

  it("发送时先落库再交给 chat 管线，附件随消息入流", async () => {
    h.pickAttachments.mockResolvedValue([draft("att-3")]);
    const { session, sessionStore, wrapper } = await mountConversation();
    const chat = useChatStore();
    const submit = vi.spyOn(chat, "submitText");

    await wrapper.get('[data-testid="composer-attach"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="attachment-chip"]')).toHaveLength(1));
    await wrapper.get('textarea[aria-label="发送消息"]').setValue("看看这张图");
    await wrapper.get('[data-testid="composer-send"]').trigger("click");

    await vi.waitFor(() => {
      expect(submit).toHaveBeenCalled();
    });
    // 落库：消息里存的是附件库路径，不带内联数据
    expect(h.materializeAttachments).toHaveBeenCalledWith(session.id, [draft("att-3")]);
    const passed = submit.mock.calls[0][1] as Attachment[];
    expect(passed[0].path).toContain("/attachments/");
    expect(passed[0].dataUrl).toBeUndefined();
    // 托盘已清空，且 user 消息确实带上了附件
    expect(wrapper.find('[data-testid="composer-attachments"]').exists()).toBe(false);
    const user = (sessionStore.getSession(session.id)?.messages ?? []).find((item) => item.role === "user");
    expect(user?.attachments?.[0].path).toContain("/attachments/");
    chat.clearSim();
  });

  it("ACP 派发时附件随 prompt 单元发出", async () => {
    h.pickAttachments.mockResolvedValue([draft("att-4")]);
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "s1", configOptions: [], imagePrompts: true });
    h.prompt.mockResolvedValue({ turnId: 1 });
    const { wrapper } = await mountConversation();
    const agent = useAgentStore();
    await agent.activateAcpProvider("opencode");

    await wrapper.get('[data-testid="composer-attach"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="attachment-chip"]')).toHaveLength(1));
    await wrapper.get('textarea[aria-label="发送消息"]').setValue("交给 agent");
    await wrapper.get('[data-testid="composer-send"]').trigger("click");

    // prompt(handle, text, units)：正文之外的图片单元由 agent store 读字节后组装
    // （首回合 prompt 前置了 schedule 围栏说明，text 断言用包含而非相等）
    await vi.waitFor(() => {
      expect(h.prompt).toHaveBeenCalled();
    });
    const [, text, units] = h.prompt.mock.calls.at(-1) as unknown as [number, string, { type: string }[]];
    expect(text).toContain("交给 agent");
    expect(units).toEqual([{ type: "image", data: "QUJD", mimeType: "image/png" }]);
    agent.stopAcp();
    useChatStore().clearSim();
  });

  it("计划模式下只发附件：挂卡 → 确认后仍把附件派发出去", async () => {
    h.pickAttachments.mockResolvedValue([draft("att-plan")]);
    h.startAgent.mockResolvedValue(8);
    h.openSession.mockResolvedValue({ sessionId: "s2", configOptions: [], imagePrompts: true });
    h.prompt.mockResolvedValue({ turnId: 2 });
    const { wrapper } = await mountConversation();
    const agent = useAgentStore();
    const settings = useSettingsStore();
    settings.planMode = true;
    await agent.activateAcpProvider("opencode");

    await wrapper.get('[data-testid="composer-attach"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="attachment-chip"]')).toHaveLength(1));
    // 正文留空也能发送（发送按钮不该被空草稿禁掉）
    expect(wrapper.get('[data-testid="composer-send"]').attributes("disabled")).toBeUndefined();
    await wrapper.get('[data-testid="composer-send"]').trigger("click");

    // 计划模式：先挂卡不派发
    await vi.waitFor(() => expect(wrapper.find('[data-testid="plan-card"]').exists()).toBe(true));
    expect(h.prompt).not.toHaveBeenCalled();

    await wrapper.get('[data-testid="plan-confirm"]').trigger("click");
    await vi.waitFor(() => expect(h.prompt).toHaveBeenCalled());
    const [, text, units] = h.prompt.mock.calls.at(-1) as unknown as [number, string, { type: string }[]];
    // planDraft 为空 → 派发的正文为空（schedule 说明前置在 hint 注入的场景才存在）
    expect(text ?? "").not.toContain("交给 agent");
    expect(units).toEqual([{ type: "image", data: "QUJD", mimeType: "image/png" }]);
    agent.stopAcp();
    useChatStore().clearSim();
  });
});
