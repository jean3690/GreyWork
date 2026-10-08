/**
 * 对话页右键菜单：整页一个 root，靠 data-ctx 分辨「消息」与「输入框」。
 *
 * 这里同时是「区域不嵌套」的回归点：输入框在 section 内部，但输入框本身**不是**另一个
 * reka root（只是带 data-ctx 的普通元素），所以右键输入框只开一个菜单。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
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
  restore: vi.fn<(root: string, reference: string) => Promise<void>>(),
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

const copyText = vi.fn<(text: string) => Promise<void>>();
vi.mock("@/lib/clipboard", () => ({ copyText: (text: string) => copyText(text) }));

// 回退走 worktree 后端：这里只关心 UI 是否把 restore 正确接上，落盘细节由 stores/rewind.test.ts 覆盖。
vi.mock("@/lib/worktree-backend", () => ({
  worktreeBackend: {
    active: () => true,
    list: () => Promise.resolve([]),
    release: () => Promise.resolve(),
    snapshot: () => Promise.resolve("refs/greywork/snap/1"),
    restore: (root: string, reference: string) => h.restore(root, reference),
  },
}));

const readText = vi.fn<() => Promise<string>>();
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: () => readText() }));

import ConversationView from "@/features/conversation/ConversationView.vue";
import { createAppRouter } from "@/router";
import { i18n } from "@/i18n";
import { useSessionStore } from "@/stores/session";

const t = i18n.global.t;

function menuItems(): DOMWrapper<Element>[] {
  return [...document.body.querySelectorAll('[data-testid="context-menu-item"]')].map((el) => new DOMWrapper(el));
}

function menuLabels(): string[] {
  return menuItems().map((entry) => entry.text());
}

function menuCount(): number {
  return document.body.querySelectorAll('[data-testid="context-menu-content"]').length;
}

async function mountConversation() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const sessionStore = useSessionStore();
  const session = sessionStore.createSession(null, "右键菜单测试");
  const router = createAppRouter();
  await router.push(`/conversation/${session.id}`);
  await router.isReady();
  const wrapper = mount(ConversationView, { global: { plugins: [pinia, i18n, router] } });
  return { session, sessionStore, wrapper };
}

function composerTextarea(wrapper: Awaited<ReturnType<typeof mountConversation>>["wrapper"]): HTMLTextAreaElement {
  return wrapper.get('textarea[aria-label="发送消息"]').element as HTMLTextAreaElement;
}

beforeEach(() => {
  localStorage.clear();
  copyText.mockReset().mockResolvedValue(undefined);
  readText.mockReset().mockResolvedValue("");
  h.restore.mockReset().mockResolvedValue(undefined);
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  document.body.innerHTML = "";
});

describe("输入框右键菜单", () => {
  it("无选区：剪切 / 复制禁用，粘贴 / 全选可用；只开一个菜单", async () => {
    const { wrapper } = await mountConversation();
    await wrapper.get('textarea[aria-label="发送消息"]').trigger("contextmenu");
    await flushPromises();

    expect(menuCount()).toBe(1);
    expect(menuLabels()).toEqual([
      t("contextMenu.composer.cut"),
      t("contextMenu.composer.copy"),
      t("contextMenu.composer.paste"),
      t("contextMenu.composer.selectAll"),
    ]);
    expect(menuItems()[0].attributes("data-disabled")).toBeDefined();
    expect(menuItems()[1].attributes("data-disabled")).toBeDefined();
    expect(menuItems()[2].attributes("data-disabled")).toBeUndefined();
  });

  it("有选区：复制把选中的文本写进剪贴板", async () => {
    const { wrapper } = await mountConversation();
    // 必须经 v-model 写值：直接改 DOM 的话，菜单打开引发的那次重渲染会把 value 抹回草稿。
    const textarea = wrapper.get('textarea[aria-label="发送消息"]');
    await textarea.setValue("hello world");
    composerTextarea(wrapper).setSelectionRange(0, 5);

    await textarea.trigger("contextmenu");
    await flushPromises();
    expect(menuItems()[1].attributes("data-disabled")).toBeUndefined();

    await menuItems()[1].trigger("click");
    await flushPromises();
    expect(copyText).toHaveBeenCalledWith("hello");
  });
});

describe("消息右键菜单", () => {
  it("右键消息：复制正文，内容是那一条", async () => {
    const { session, sessionStore, wrapper } = await mountConversation();
    sessionStore.appendMessage(session.id, { id: "m-1", role: "user", content: "请整理本周改动", ts: Date.now() });
    await flushPromises();

    await wrapper.get('[data-ctx="message"]').trigger("contextmenu");
    await flushPromises();

    expect(menuCount()).toBe(1);
    expect(menuLabels()).toEqual([t("contextMenu.message.copyBody")]);

    await menuItems()[0].trigger("click");
    await flushPromises();
    expect(copyText).toHaveBeenCalledWith("请整理本周改动");
  });

  it("右键页头空白：不弹菜单", async () => {
    const { wrapper } = await mountConversation();
    await wrapper.get("section").trigger("contextmenu");
    await flushPromises();
    expect(menuCount()).toBe(0);
  });
});

describe("消息回退", () => {
  /** 会话起手：带快照的 u1 + 助手 a1 + 带快照的 u2（u2 的回合起点即回退目标）。 */
  function seed(sessionStore: ReturnType<typeof useSessionStore>, sessionId: string): void {
    sessionStore.appendMessage(sessionId, { id: "u1", role: "user", content: "第一轮", ts: 1, snapshotRef: "refs/greywork/snap/1" });
    sessionStore.appendMessage(sessionId, { id: "a1", role: "assistant", content: "答复", ts: 2 });
    sessionStore.appendMessage(sessionId, { id: "u2", role: "user", content: "第二轮", ts: 3, snapshotRef: "refs/greywork/snap/2" });
  }

  function confirmDialog(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
  }

  function dialogButtons(): HTMLButtonElement[] {
    return [...(confirmDialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
  }

  it("带快照的用户消息多一条「回退到这里」；助手消息 / 无快照消息没有", async () => {
    const { session, sessionStore, wrapper } = await mountConversation();
    seed(sessionStore, session.id);
    sessionStore.appendMessage(session.id, { id: "u9", role: "user", content: "没有快照", ts: 4 });
    await flushPromises();

    await wrapper.get('[data-message-id="u2"]').trigger("contextmenu");
    await flushPromises();
    expect(menuLabels()).toEqual([t("contextMenu.message.copyBody"), t("contextMenu.message.rewind")]);

    await wrapper.get('[data-message-id="a1"]').trigger("contextmenu");
    await flushPromises();
    expect(menuLabels()).toEqual([t("contextMenu.message.copyBody")]);

    await wrapper.get('[data-message-id="u9"]').trigger("contextmenu");
    await flushPromises();
    expect(menuLabels()).toEqual([t("contextMenu.message.copyBody")]);
  });

  it("点「回退到这里」弹确认；确认后按 cwd+ref 硬恢复并截断消息流", async () => {
    const { session, sessionStore, wrapper } = await mountConversation();
    seed(sessionStore, session.id);
    sessionStore.setAcpBinding(session.id, { sessionId: "s1", providerId: "p1", cwd: "/wt", savedAt: 1 });
    await flushPromises();

    await wrapper.get('[data-message-id="u2"]').trigger("contextmenu");
    await flushPromises();
    await menuItems()[1].trigger("click"); // [复制正文, 回退到这里]
    await flushPromises();

    expect(confirmDialog()?.textContent).toContain(t("chat.rewindConfirmTitle"));

    dialogButtons()[1].click(); // [取消, 回退]
    await flushPromises();

    expect(h.restore).toHaveBeenCalledWith("/wt", "refs/greywork/snap/2");
    expect(sessionStore.getSession(session.id)?.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    // 回退后绑定被清（下个回合开新会话）。
    expect(sessionStore.getSession(session.id)?.acp).toBeUndefined();
  });

  it("取消：不调 restore，消息流不变", async () => {
    const { session, sessionStore, wrapper } = await mountConversation();
    seed(sessionStore, session.id);
    sessionStore.setAcpBinding(session.id, { sessionId: "s1", providerId: "p1", cwd: "/wt", savedAt: 1 });
    await flushPromises();

    await wrapper.get('[data-message-id="u2"]').trigger("contextmenu");
    await flushPromises();
    await menuItems()[1].trigger("click");
    await flushPromises();

    dialogButtons()[0].click(); // 取消
    await flushPromises();

    expect(h.restore).not.toHaveBeenCalled();
    expect(sessionStore.getSession(session.id)?.messages).toHaveLength(3);
  });
});
