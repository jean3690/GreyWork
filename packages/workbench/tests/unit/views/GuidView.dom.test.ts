// Guid 引导页契约：快速意图卡片与输入框都通往新会话路由；发送后会话里落下用户消息。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import GuidView from "@/views/GuidView.vue";
import { createAppRouter } from "@/router";
import { i18n } from "@/i18n";
import { useSessionStore } from "@/stores/session";
import { useChatStore } from "@/stores/chat";

async function mountGuid() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createAppRouter();
  await router.push("/guid");
  await router.isReady();
  const wrapper = mount(GuidView, { global: { plugins: [pinia, i18n, router] } });
  return { pinia, router, wrapper };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("GuidView", () => {
  it("渲染输入卡与运行模式指示", async () => {
    const { wrapper } = await mountGuid();
    expect(wrapper.find('textarea[aria-label="发送消息"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("发送");
    expect(wrapper.text()).toContain("运行环境：本地");
  });

  it("配置选择独占输入框下方一行，不与发送按钮同级", async () => {
    const { wrapper } = await mountGuid();
    const textarea = wrapper.get('textarea[aria-label="发送消息"]');
    const configRow = wrapper.get('[data-testid="composer-config-row"]');
    const actionRow = wrapper.get('[data-testid="composer-action-row"]');

    expect(textarea.element.nextElementSibling).toBe(configRow.element);
    expect(configRow.element.nextElementSibling).toBe(actionRow.element);
    expect(configRow.find("button").exists()).toBe(false);
    // 操作行左侧是附件入口，发送按钮在右侧（各带自己的 testid，别用「第几个 button」定位）
    expect(actionRow.find('[data-testid="composer-attach"]').exists()).toBe(true);
    expect(actionRow.get('[data-testid="composer-send"]').text()).toContain("发送");
  });

  it("输入后回车：建新会话、落下用户消息、跳到该会话", async () => {
    const { router, wrapper } = await mountGuid();
    const sessionStore = useSessionStore();
    const chatStore = useChatStore();
    const before = sessionStore.sessions.length;

    await wrapper.get('textarea[aria-label="发送消息"]').setValue("分析站点客流数据");
    await wrapper.get('textarea[aria-label="发送消息"]').trigger("keydown", { key: "Enter" });
    // mock 演示管线的 sim 定时器归 chat store 管，测完清掉避免残留
    try {
      await vi.waitFor(() => {
        expect(router.currentRoute.value.path).toContain(`/conversation/${sessionStore.activeSessionId}`);
      });
      expect(sessionStore.sessions.length).toBe(before + 1);
      const messages = sessionStore.getSession(sessionStore.activeSessionId ?? "")?.messages ?? [];
      expect(messages.some((message) => message.role === "user" && message.content === "分析站点客流数据")).toBe(true);
      // 草稿清空，避免重发
      expect((wrapper.get('textarea[aria-label="发送消息"]').element as HTMLTextAreaElement).value).toBe("");
    } finally {
      chatStore.clearSim();
    }
  });
});

describe("GuidView · 斜杠命令", () => {
  it("输入 / 弹出内置命令菜单，Esc 关闭", async () => {
    const { wrapper } = await mountGuid();
    const textarea = wrapper.get('textarea[aria-label="发送消息"]');
    await textarea.setValue("/");
    expect(wrapper.find('[data-testid="slash-menu"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="slash-option"]')).toHaveLength(7);

    await textarea.trigger("keydown", { key: "Escape" });
    expect(wrapper.find('[data-testid="slash-menu"]').exists()).toBe(false);
  });

  it("选中模板命令填入草稿，回车后随新会话落为用户消息", async () => {
    const { router, wrapper } = await mountGuid();
    const sessionStore = useSessionStore();
    const chatStore = useChatStore();
    const textarea = wrapper.get('textarea[aria-label="发送消息"]');

    await textarea.setValue("/rep");
    await textarea.trigger("keydown", { key: "Enter" });
    const template = i18n.global.t("chat.commands.report.template");
    expect((textarea.element as HTMLTextAreaElement).value).toBe(template);
    expect(wrapper.find('[data-testid="slash-menu"]').exists()).toBe(false);

    try {
      await textarea.trigger("keydown", { key: "Enter" });
      await vi.waitFor(() => {
        expect(router.currentRoute.value.path).toContain(`/conversation/${sessionStore.activeSessionId}`);
      });
      const messages = sessionStore.getSession(sessionStore.activeSessionId ?? "")?.messages ?? [];
      expect(messages.some((message) => message.role === "user" && message.content === template)).toBe(true);
    } finally {
      chatStore.clearSim();
    }
  });
});
