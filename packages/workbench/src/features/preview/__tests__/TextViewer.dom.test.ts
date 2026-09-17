/**
 * 只读文本 viewer 的三条契约。
 *
 * 这里把 `@codemirror/view` mock 成加载失败，**刻意只测降级路径**：happy-dom 没有布局
 * 与测量能力，CodeMirror 能构造但渲染不出可断言的文本，去断言它的内部 DOM 只会得到
 * 一个既脆弱又不说明问题的用例。CodeMirror 的真实渲染（.cm-editor / 行号 / 内容）
 * 已在浏览器里实测确认。这里守住的是「CM 起不来也不白屏」这条我自己写的兜底逻辑，
 * 以及两条错误通道。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@codemirror/view", () => {
  throw new Error("CodeMirror 在测试环境不可用");
});

import TextViewer from "@/features/preview/TextViewer.vue";
import { usePreviewStore } from "@/stores/preview";
import { useVfsStore } from "@/stores/vfs";
import type { PreviewTab } from "@/stores/preview";

function tabOf(id: string): PreviewTab {
  const tab = usePreviewStore().tabs.find((candidate) => candidate.id === id);
  if (!tab) throw new Error("tab 未登记");
  return tab;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  // 降级路径会 console.warn 留线索，测试里不需要看
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("TextViewer", () => {
  it("VFS 来源：CodeMirror 起不来时降级为纯文本，内容仍然可见", async () => {
    const vfs = useVfsStore();
    await vfs.write("notes/demo.txt", "第一行\n第二行");
    const id = usePreviewStore().open("notes/demo.txt");

    const wrapper = mount(TextViewer, { props: { tab: tabOf(id) } });
    await flushPromises();
    await wrapper.vm.$nextTick();

    expect(wrapper.find("pre").exists()).toBe(true);
    expect(wrapper.text()).toContain("第一行");
    expect(wrapper.text()).toContain("第二行");
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it("读取失败：显示 role=alert 的错误行，不白屏", async () => {
    const id = usePreviewStore().open("notes/missing.txt");
    const wrapper = mount(TextViewer, { props: { tab: tabOf(id) } });
    await flushPromises();

    const alert = wrapper.find('[role="alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain("读取失败");
  });

  it("disk 来源在浏览器态给出人话错误，而不是 invoke 的原始异常", async () => {
    const id = usePreviewStore().open("/abs/path/report.txt", "report.txt", "disk");
    expect(tabOf(id).source).toBe("disk");

    const wrapper = mount(TextViewer, { props: { tab: tabOf(id) } });
    await flushPromises();

    const alert = wrapper.find('[role="alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain("浏览器态没有磁盘通道");
  });
});
