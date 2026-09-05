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
  it("渲染问候语与六张快速意图卡片", async () => {
    const { wrapper } = await mountGuid();
    expect(wrapper.text()).toContain("你好，我是 GreyWork");
    expect(wrapper.text()).toContain("日报");
    expect(wrapper.text()).toContain("性能体检");
    expect(wrapper.text()).toContain("定时自动化");
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
