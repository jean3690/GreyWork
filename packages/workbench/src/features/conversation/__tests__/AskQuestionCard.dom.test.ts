/**
 * AskUserQuestion 选择卡契约：
 * - 单选单题：点选项即提交（对齐工具语义的即时选择）
 * - 多选 / 多题：选择后显式提交，未作答不给提交
 * - 作答后卡片收口为只读态，答案以一条用户消息回传同一会话
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "@/i18n";
import AskQuestionCard from "@/features/conversation/AskQuestionCard.vue";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import type { ThreadMessage } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const h = vi.hoisted(() => ({
  isAvailable: vi.fn(() => true),
  homeDir: vi.fn<() => Promise<string | null>>(() => Promise.resolve("/home/test")),
}));

vi.mock("@greywork/acp", () => ({
  createAcpClient: () =>
    ({
      isAvailable: () => h.isAvailable(),
      onEvent: () => Promise.resolve(() => undefined),
    }) as never,
  desktopHomeDir: () => h.homeDir(),
}));

function seedSession() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const chat = useChatStore();
  const session = useSessionStore().createSession(null, "提问测试");
  chat.activeThreadId = session.id;
  return { pinia, chat, threadId: session.id };
}

function askMessage(ask: ThreadMessage["ask"]): ThreadMessage {
  return { id: "ask-1", role: "assistant", content: "", ts: Date.now(), ask };
}

function render(pinia: ReturnType<typeof createPinia>, threadId: string, message: ThreadMessage) {
  return mount(AskQuestionCard, { props: { threadId, message }, global: { plugins: [pinia, i18n] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isAvailable.mockImplementation(() => true);
  h.homeDir.mockImplementation(() => Promise.resolve("/home/test"));
});

describe("AskQuestionCard", () => {
  it("单选单题：点选项即提交，卡片转只读，答案回传为一条用户消息", async () => {
    const { pinia, chat, threadId } = seedSession();
    const message = askMessage({
      questions: [{ question: "继续吗？", options: [{ label: "继续" }, { label: "停止" }] }],
    });
    const wrapper = render(pinia, threadId, message);

    expect(wrapper.get('[data-testid="ask-card"]').attributes("data-settled")).toBe("false");
    await wrapper.findAll('[data-testid="ask-option-0"]')[0]!.trigger("click");

    expect(message.ask?.answeredAt).toBeTypeOf("number");
    expect(wrapper.find('[data-testid="ask-card-answered"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("继续吗？：继续");
    expect(chat.busy).toBe(true);
    const sent = chat.threads[threadId].find((m) => m.role === "user");
    expect(sent?.content).toBe("继续吗？：继续");
    chat.clearSim();
  });

  it("单选单题：默认没有提交键（点选项即走）；一旦自填「其他」就给出提交入口", async () => {
    const { pinia, chat, threadId } = seedSession();
    const message = askMessage({
      questions: [{ question: "继续吗？", options: [{ label: "继续" }, { label: "停止" }] }],
    });
    const wrapper = render(pinia, threadId, message);
    expect(wrapper.find('[data-testid="ask-submit"]').exists()).toBe(false);

    await wrapper.get('[data-testid="ask-custom-0"]').setValue("先等等");
    expect(wrapper.find('[data-testid="ask-submit"]').exists()).toBe(true);
    await wrapper.get('[data-testid="ask-submit"]').trigger("click");

    expect(message.ask?.answers?.[0]).toEqual({ question: "继续吗？", labels: [], custom: "先等等" });
    chat.clearSim();
  });

  it("多选：选多项后提交，未选满不给提交，答案带多选前缀", async () => {
    const { pinia, chat, threadId } = seedSession();
    const message = askMessage({
      questions: [{ question: "选模块", multiSelect: true, options: [{ label: "前端" }, { label: "后端" }] }],
    });
    const wrapper = render(pinia, threadId, message);

    const submit = wrapper.get('[data-testid="ask-submit"]');
    expect(submit.attributes("disabled")).toBeDefined();
    await wrapper.findAll('[data-testid="ask-option-0"]')[0]!.trigger("click");
    await wrapper.findAll('[data-testid="ask-option-0"]')[1]!.trigger("click");
    expect(submit.attributes("disabled")).toBeUndefined();
    await submit.trigger("click");

    expect(message.ask?.answers?.[0]).toEqual({ question: "选模块", labels: ["前端", "后端"], custom: undefined });
    const sent = chat.threads[threadId].find((m) => m.role === "user");
    expect(sent?.content).toBe("[多选] 选模块：前端、后端");
    chat.clearSim();
  });

  it("多题：逐题作答后统一提交；只答一题不给提交", async () => {
    const { pinia, chat, threadId } = seedSession();
    const message = askMessage({
      questions: [
        { question: "名字？", options: [{ label: "A" }] },
        { question: "范围？", options: [{ label: "全部" }] },
      ],
    });
    const wrapper = render(pinia, threadId, message);

    const submit = wrapper.get('[data-testid="ask-submit"]');
    await wrapper.findAll('[data-testid="ask-option-0"]')[0]!.trigger("click");
    expect(submit.attributes("disabled")).toBeDefined();
    await wrapper.findAll('[data-testid="ask-option-1"]')[0]!.trigger("click");
    expect(submit.attributes("disabled")).toBeUndefined();
    await submit.trigger("click");

    expect(message.ask?.answers).toHaveLength(2);
    expect(chat.busy).toBe(true);
    chat.clearSim();
  });

  it("「其他」自由输入也算作答", async () => {
    const { pinia, chat, threadId } = seedSession();
    const message = askMessage({
      questions: [{ question: "选模块", multiSelect: true, options: [{ label: "前端" }] }],
    });
    const wrapper = render(pinia, threadId, message);

    const submit = wrapper.get('[data-testid="ask-submit"]');
    expect(submit.attributes("disabled")).toBeDefined();
    await wrapper.get('[data-testid="ask-custom-0"]').setValue("自定义答案");
    expect(submit.attributes("disabled")).toBeUndefined();
    await submit.trigger("click");

    expect(message.ask?.answers?.[0]?.custom).toBe("自定义答案");
    const sent = chat.threads[threadId].find((m) => m.role === "user");
    expect(sent?.content).toContain("自定义答案");
    chat.clearSim();
  });

  it("已作答的消息直接渲染只读态，不再给选项", () => {
    const { pinia, threadId } = seedSession();
    const message = askMessage({
      questions: [{ question: "继续吗？", options: [{ label: "继续" }, { label: "停止" }] }],
      answers: [{ question: "继续吗？", labels: ["停止"] }],
      answeredAt: Date.now(),
    });
    const wrapper = render(pinia, threadId, message);

    expect(wrapper.get('[data-testid="ask-card"]').attributes("data-settled")).toBe("true");
    expect(wrapper.find('[data-testid="ask-card-answered"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="ask-option-0"]')).toHaveLength(0);
    expect(wrapper.find('[data-testid="ask-submit"]').exists()).toBe(false);
  });
});
