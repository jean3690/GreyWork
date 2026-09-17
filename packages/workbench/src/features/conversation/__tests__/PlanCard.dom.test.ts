/**
 * 计划模式卡片契约：planPending 消息呈现「实施计划 · 确认后执行」卡，
 * ACP 路径带派发目标与意图草稿，mock 路径带步骤时间线；确认交回管线、取消摘卡。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "@/i18n";
import PlanCard from "@/features/conversation/PlanCard.vue";
import { useAgentStore } from "@/stores/agent";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import type { ThreadMessage } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const h = vi.hoisted(() => ({
  isAvailable: vi.fn(() => true),
  homeDir: vi.fn<() => Promise<string | null>>(() => Promise.resolve("/home/test")),
  listener: null as ((event: { kind: string; payload: unknown }) => void) | null,
}));

vi.mock("@greywork/acp", () => ({
  createAcpClient: () =>
    ({
      isAvailable: () => h.isAvailable(),
      onEvent: (listener: (event: { kind: string; payload: unknown }) => void) => {
        h.listener = listener;
        return Promise.resolve(() => undefined);
      },
    }) as never,
  desktopHomeDir: () => h.homeDir(),
}));

function seedSession() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const chat = useChatStore();
  const session = useSessionStore().createSession(null, "计划测试");
  chat.activeThreadId = session.id;
  return { pinia, chat, session };
}

function render(pinia: ReturnType<typeof createPinia>, threadId: string, message: ThreadMessage) {
  return mount(PlanCard, { props: { threadId, message }, global: { plugins: [pinia, i18n] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isAvailable.mockImplementation(() => true);
  h.homeDir.mockImplementation(() => Promise.resolve("/home/test"));
  h.listener = null;
});

describe("PlanCard", () => {
  it("mock 计划卡：展示步骤时间线，无派发目标徽标，可确认/取消", async () => {
    const { pinia, chat } = seedSession();
    const settings = useSettingsStore();
    settings.planMode = true;
    const pending = chat.submitText("整理周报");
    expect(pending?.planPending).toBe(true);
    expect(pending?.steps?.length).toBeGreaterThan(0);

    const wrapper = render(pinia, chat.activeThreadId, pending!);
    expect(wrapper.text()).toContain("实施计划 · 确认后执行");
    expect(wrapper.findAll('[data-testid="plan-steps"] li')).toHaveLength(pending!.steps!.length);
    expect(wrapper.find('[data-testid="plan-target"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("确认执行");
    expect(wrapper.text()).toContain("取消方案");
  });

  it("ACP 计划卡：显示派发目标徽标与意图草稿", () => {
    const { pinia, chat } = seedSession();
    const message: ThreadMessage = {
      id: "p1",
      role: "assistant",
      content: "",
      ts: Date.now(),
      acp: "OpenCode",
      planPending: true,
      planDraft: "重构模块 A 的接口",
    };
    const wrapper = render(pinia, chat.activeThreadId, message);
    expect(wrapper.get('[data-testid="plan-target"]').text()).toContain("OpenCode");
    expect(wrapper.text()).toContain("重构模块 A 的接口");
    expect(wrapper.text()).toContain("确认后执行");
  });

  it("mock 确认：解除计划卡并交回管线（planDraft 作为意图）", async () => {
    const { pinia, chat } = seedSession();
    const settings = useSettingsStore();
    settings.planMode = true;
    const pending = chat.submitText("整理周报")!;
    const wrapper = render(pinia, chat.activeThreadId, pending);

    await wrapper.get('[data-testid="plan-confirm"]').trigger("click");

    // mock 管线同步启动：busy 置位、卡片解除。
    expect(pending.planPending).toBe(false);
    expect(chat.busy).toBe(true);
    expect(chat.threads[chat.activeThreadId].some((m) => m.id === pending.id)).toBe(true);
    chat.clearSim();
  });

  it("ACP 确认：委托 agent.confirmAcpPlan 派发同一支架", async () => {
    const { pinia, chat } = seedSession();
    const agent = useAgentStore();
    const confirmSpy = vi.spyOn(agent, "confirmAcpPlan");
    const message: ThreadMessage = {
      id: "p2",
      role: "assistant",
      content: "",
      ts: Date.now(),
      acp: "OpenCode",
      planPending: true,
      planDraft: "重构模块 A",
    };
    const wrapper = render(pinia, chat.activeThreadId, message);

    await wrapper.get('[data-testid="plan-confirm"]').trigger("click");
    expect(confirmSpy).toHaveBeenCalledWith(chat.activeThreadId, message);
  });

  it("取消：摘掉计划卡，保留用户消息", async () => {
    const { pinia, chat } = seedSession();
    const settings = useSettingsStore();
    settings.planMode = true;
    const pending = chat.submitText("整理周报")!;
    const wrapper = render(pinia, chat.activeThreadId, pending);

    await wrapper.get('[data-testid="plan-cancel"]').trigger("click");

    const list = chat.threads[chat.activeThreadId];
    expect(list.some((m) => m.id === pending.id)).toBe(false);
    expect(list.map((m) => m.role)).toEqual(["user"]);
    expect(chat.busy).toBe(false);
  });
});
