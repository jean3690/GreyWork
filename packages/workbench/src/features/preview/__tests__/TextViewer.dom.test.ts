/**
 * 文本 viewer 的兜底契约：CM 起不来不白屏、两条错误通道、二进制/非 UTF-8 的降级。
 *
 * 这里把 `@codemirror/view` mock 成加载失败，**刻意只测降级路径**：happy-dom 没有布局
 * 与测量能力，CodeMirror 能构造但渲染不出可断言的文本，去断言它的内部 DOM 只会得到
 * 一个既脆弱又不说明问题的用例。CodeMirror 的真实渲染（.cm-editor / 行号 / 内容）
 * 已在浏览器里实测确认；可编辑与保存的调度由 lib/preview-edit-guard 的用例覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@codemirror/view", () => {
  throw new Error("CodeMirror 在测试环境不可用");
});

import type * as WorkspaceFiles from "@/state/workspaceFiles";

// 只覆盖探测与磁盘读：其余（vfs 通道等）保持真实实现。
vi.mock("@/state/workspaceFiles", async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceFiles>();
  return { ...actual, probeWorkspaceFile: vi.fn(), readTextFile: vi.fn() };
});

import TextViewer from "@/features/preview/TextViewer.vue";
import { probeWorkspaceFile, readTextFile } from "@/state/workspaceFiles";
import { usePreviewStore } from "@/stores/preview";
import { useVfsStore } from "@/stores/vfs";
import type { PreviewTab } from "@/stores/preview";

const probeMock = vi.mocked(probeWorkspaceFile);
const readTextMock = vi.mocked(readTextFile);

/** 探测结果缺省值：普通 UTF-8 文本，可编辑。 */
function probeInfo(partial: Partial<Awaited<ReturnType<typeof probeWorkspaceFile>>> = {}) {
  return { size: 12, binary: false, utf8: true, bom: false, crlf: false, ...partial };
}

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
  // 缺省按「浏览器态」处理：探测拿不到 IPC，随即落到那句人话错误上。
  probeMock.mockReset().mockRejectedValue(new Error("没有磁盘通道"));
  readTextMock.mockReset().mockResolvedValue("");
});

/** 桌面态标记：`isTauriRuntime()` 认 window 上的 `__TAURI_INTERNALS__`。 */
function stubTauriRuntime(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

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

describe("TextViewer 二进制与非 UTF-8 兜底", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("探测判为二进制：给占位而不是乱码文本，且不去读内容", async () => {
    stubTauriRuntime();
    probeMock.mockResolvedValue(probeInfo({ binary: true }));
    const id = usePreviewStore().open("/data/blob.zip", "blob.zip", "disk");

    const wrapper = mount(TextViewer, { props: { tab: tabOf(id) } });
    await flushPromises();

    expect(wrapper.find('[data-testid="text-viewer-binary"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("二进制文件");
    // 二进制不读内容：读回来只会是乱码，还要白付一次最多 10MB 的 IPC
    expect(readTextMock).not.toHaveBeenCalled();
  });

  it("非 UTF-8：只读预览 + 说明为什么不能改", async () => {
    stubTauriRuntime();
    probeMock.mockResolvedValue(probeInfo({ utf8: false }));
    readTextMock.mockResolvedValue("配置项：启用");
    const id = usePreviewStore().open("/data/legacy.ini", "legacy.ini", "disk");

    const wrapper = mount(TextViewer, { props: { tab: tabOf(id) } });
    await flushPromises();

    expect(wrapper.find('[data-testid="text-viewer-readonly"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("UTF-8");
    expect(wrapper.find("pre").text()).toContain("配置项：启用");
  });

  it("UTF-8 文本：不显示只读说明", async () => {
    stubTauriRuntime();
    probeMock.mockResolvedValue(probeInfo());
    readTextMock.mockResolvedValue("hello");
    const id = usePreviewStore().open("/data/ok.txt", "ok.txt", "disk");

    const wrapper = mount(TextViewer, { props: { tab: tabOf(id) } });
    await flushPromises();

    expect(wrapper.find('[data-testid="text-viewer-readonly"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="text-viewer-binary"]').exists()).toBe(false);
  });
});
