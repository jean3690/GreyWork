// 阅读态滚动契约：上翻后不再被流式输出拽回底部；底部浮出「回到底部」，点击才回锚。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
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

const T = 1_700_000_000_000;

async function mountSeeded() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSettingsStore().workspaceDir = "/home/test";
  const sessionStore = useSessionStore();
  const session = sessionStore.createSession(null, "滚动测试");
  sessionStore
    .ensure(session.id)
    .push({ id: "u1", role: "user", content: "旧输入", ts: T }, { id: "a1", role: "assistant", content: "旧回复", ts: T + 1000 });
  const router = createAppRouter();
  await router.push(`/conversation/${session.id}`);
  await router.isReady();
  const wrapper = mount(ConversationView, { global: { plugins: [pinia, i18n, router] } });
  await useAgentStore().activateAcpProvider("opencode");
  return { wrapper, sessionStore, session };
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

describe("ConversationView · 阅读态滚动", () => {
  it("上翻后浮出「回到底部」，新内容不抢滚动；点击才回锚", async () => {
    const { wrapper, sessionStore, session } = await mountSeeded();

    const scroll = wrapper.get('[data-testid="conversation-scroll"]');
    const el = scroll.element as HTMLElement;
    const scrollTo = vi.fn();
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(el, "scrollTo", { configurable: true, value: scrollTo });

    // 距底 600px：解除钉底，浮出按钮。
    el.scrollTop = 0;
    await scroll.trigger("scroll");
    expect(wrapper.find('[data-testid="scroll-to-bottom"]').exists()).toBe(true);

    // 流式新内容到达：不调用 scrollTo，按钮仍在。
    scrollTo.mockClear();
    sessionStore.ensure(session.id).push({ id: "a2", role: "assistant", content: "新的流式内容", ts: T + 2000 });
    await nextTick();
    await nextTick();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="scroll-to-bottom"]').exists()).toBe(true);

    // 点按钮：回锚并收起按钮。
    await wrapper.get('[data-testid="scroll-to-bottom"]').trigger("click");
    await nextTick();
    expect(scrollTo).toHaveBeenCalled();
    expect(wrapper.find('[data-testid="scroll-to-bottom"]').exists()).toBe(false);
  });
});
