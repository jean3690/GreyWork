// 评论桥契约：记进评论草稿 + 批注追加进输入框草稿；空批注忽略；卸载解绑。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
import { appEvents } from "@/events";
import { useChatCommentBridge } from "@/lib/use-chat-comment";
import type { MessageComment } from "@/types";

function mountBridge() {
  const comments = ref<MessageComment[]>([]);
  const draft = ref("");
  const textarea = ref<HTMLTextAreaElement | null>(null);
  const Host = defineComponent({
    setup() {
      useChatCommentBridge(comments, draft, textarea);
      return () =>
        h("textarea", {
          ref: textarea,
          value: draft.value,
          onInput: (event: Event) => (draft.value = (event.target as HTMLTextAreaElement).value),
        });
    },
  });
  return { comments, draft, wrapper: mount(Host, { attachTo: document.body }) };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  appEvents.clear();
});

describe("useChatCommentBridge", () => {
  it("收到评论：记进评论草稿，并把批注追加进输入框草稿", async () => {
    const { comments, draft, wrapper } = mountBridge();
    appEvents.emit("chat:comment", { quote: "原句", note: "这里要改", source: "a.md" });
    await flushPromises();

    expect(comments.value).toHaveLength(1);
    expect(comments.value[0]).toMatchObject({ quote: "原句", note: "这里要改", source: "a.md" });
    expect(draft.value).toBe("这里要改");
    wrapper.unmount();
  });

  it("空批注忽略（评论必须有内容）", async () => {
    const { comments, draft, wrapper } = mountBridge();
    appEvents.emit("chat:comment", { quote: "原句", note: "   " });
    await flushPromises();

    expect(comments.value).toHaveLength(0);
    expect(draft.value).toBe("");
    wrapper.unmount();
  });

  it("多条评论的批注以空行追加", async () => {
    const { draft, wrapper } = mountBridge();
    appEvents.emit("chat:comment", { quote: "a", note: "第一条" });
    await flushPromises();
    appEvents.emit("chat:comment", { quote: "b", note: "第二条" });
    await flushPromises();

    expect(draft.value).toBe("第一条\n\n第二条");
    wrapper.unmount();
  });

  it("卸载后解绑", () => {
    const { wrapper } = mountBridge();
    expect(appEvents.listenerCount("chat:comment")).toBe(1);
    wrapper.unmount();
    expect(appEvents.listenerCount("chat:comment")).toBe(0);
  });
});
