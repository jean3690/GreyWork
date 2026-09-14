/**
 * 预填桥的契约：写草稿、聚焦、光标到末尾、卸载解绑。
 *
 * 光标到末尾这条不是洁癖 —— 预填的是提示词开头（「请解释我附加的这段内容…」），
 * 光标若停在开头，用户接着打字会插在提示词前面，写出来是反的。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref, type Ref } from "vue";
import { appEvents } from "@/events";
import { useChatPrefillBridge } from "@/lib/use-chat-prefill";

function mountBridge(initial = ""): {
  draft: Ref<string>;
  textarea: Ref<HTMLTextAreaElement | null>;
  wrapper: ReturnType<typeof mount>;
} {
  const draft = ref(initial);
  const textarea = ref<HTMLTextAreaElement | null>(null);
  const Host = defineComponent({
    setup() {
      useChatPrefillBridge(draft, textarea);
      return () =>
        h("textarea", {
          ref: textarea,
          value: draft.value,
          onInput: (e: Event) => (draft.value = (e.target as HTMLTextAreaElement).value),
        });
    },
  });
  return { draft, textarea, wrapper: mount(Host, { attachTo: document.body }) };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  appEvents.clear();
});

describe("useChatPrefillBridge", () => {
  it("草稿为空时替换，并聚焦到末尾", async () => {
    const { draft, textarea, wrapper } = mountBridge();

    appEvents.emit("chat:prefill", { text: "请解释这段内容" });
    await flushPromises();
    await nextTick();

    expect(draft.value).toBe("请解释这段内容");
    expect(document.activeElement).toBe(textarea.value);
    expect(textarea.value?.selectionStart).toBe("请解释这段内容".length);
    wrapper.unmount();
  });

  it("草稿非空时空行追加，不覆盖用户已经写的内容", async () => {
    const { draft, wrapper } = mountBridge("我原本写了一半的问题");

    appEvents.emit("chat:prefill", { text: "请改写这段内容", mode: "append" });
    await flushPromises();

    expect(draft.value).toBe("我原本写了一半的问题\n\n请改写这段内容");
    wrapper.unmount();
  });

  it("append 到空草稿不留开头的空行", async () => {
    const { draft, wrapper } = mountBridge();

    appEvents.emit("chat:prefill", { text: "请解释", mode: "append" });
    await flushPromises();

    expect(draft.value).toBe("请解释");
    wrapper.unmount();
  });

  it("缺省 mode 为 replace", async () => {
    const { draft, wrapper } = mountBridge("旧内容");

    appEvents.emit("chat:prefill", { text: "新内容" });
    await flushPromises();

    expect(draft.value).toBe("新内容");
    wrapper.unmount();
  });

  it("卸载后解绑，不再写入草稿（否则用例之间会互相触发）", async () => {
    const { draft, wrapper } = mountBridge();
    expect(appEvents.listenerCount("chat:prefill")).toBe(1);

    wrapper.unmount();
    expect(appEvents.listenerCount("chat:prefill")).toBe(0);

    appEvents.emit("chat:prefill", { text: "不该被写入" });
    await flushPromises();
    expect(draft.value).toBe("");
  });
});
