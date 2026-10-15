/**
 * LibreOffice「高保真(PDF)」预览接进预览区的可观察行为。
 *
 * 决策矩阵（covered kind 默认走 PDF、soffice 不可用回落原生、转换失败回落原生并说明原因）
 * 在 `PreviewSurface.vue` 里，这里补的是矩阵答不了的那半：默认是否真的换了 viewer、
 * soffice 不在场是否真的停在原生、以及转换失败是否**回落原生 viewer 并通知**，绝不出现
 * 「开了高保真反而打不开」。
 *
 * 与云端分支同一套 mount 夹具（`host-ipc` 的 `invoke` 被整体 mock）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal()),
  invoke: vi.fn(),
}));

import PreviewSurface from "@/features/preview/PreviewSurface.vue";
import { useNoticeStore } from "@/stores/notice";
import type { PreviewTab } from "@/stores/preview";

const invokeMock = vi.mocked((await import("@greywork/host-ipc")).invoke);

function docxTab(): PreviewTab {
  return {
    id: "pv-1",
    path: "/work/report.docx",
    name: "report.docx",
    kind: "docx",
    source: "disk",
    revision: 1,
  };
}

/** 等异步 viewer 落定（defineAsyncComponent 跨若干宏任务）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await flushPromises();
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await flushPromises();
}

/** 无特定条件时让微任务跑干净（用于断言「没有发生某事」）。 */
async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function overrideRuntime(mode: "server" | "browser-preview"): void {
  (window as unknown as Record<string, unknown>).__GREYWORK_RUNTIME__ = mode;
}

function mountSurface(tab: PreviewTab = docxTab()): VueWrapper {
  overrideRuntime("server");
  return mount(PreviewSurface, { props: { tab } });
}

const find = (wrapper: VueWrapper, testId: string): boolean =>
  wrapper.find(`[data-testid="${testId}"]`).exists();

const officePdfNotices = (): ReturnType<typeof useNoticeStore>["list"] =>
  useNoticeStore().list.filter((notice) => notice.key === "office-pdf-fallback:pv-1");

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  invokeMock.mockReset();
  // 本地 viewer 会自己去读文件；本文件不验那条链路，统一拒绝把它停在错误态。
  invokeMock.mockRejectedValue(new Error("本用例不提供本地内容"));
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__GREYWORK_RUNTIME__;
});

describe("预览区的 LibreOffice 高保真分支", () => {
  it("soffice 可用：默认走高保真(PDF)，不渲染原生 doc viewer", async () => {
    // 转换保持 pending：本用例只证「选了高保真路径、调了转换命令、原生 viewer 没挂」，
    // 不把 pdf.js 拉进测试（它在 happy-dom 里起不了 worker）。
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "office_convert_info") return { available: true, path: "/usr/bin/soffice", source: "path" };
      if (command === "office_convert_to_pdf") return new Promise<Uint8Array>(() => {});
      throw new Error(`未预期的命令 ${command}`);
    });

    const wrapper = mountSurface();
    await waitFor(() => find(wrapper, "office-pdf-viewer"));

    expect(find(wrapper, "office-pdf-viewer")).toBe(true);
    expect(find(wrapper, "doc-viewer")).toBe(false);
    // 决策证据：转换命令确实被发起（走的就是高保真路径）。
    expect(invokeMock).toHaveBeenCalledWith("office_convert_to_pdf", { path: "/work/report.docx" });
    // 故意不把转换 promise 落定：一旦 bytes 回来 PdfViewer 会拉起 pdf.js（happy-dom 起不了
    // worker），本用例只证「选了高保真路径」即可，不需要真把 PDF 渲染出来。
  });

  it("soffice 不可用：默认回落原生 viewer，不调转换命令", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "office_convert_info") return { available: false, path: null, source: null };
      throw new Error(`未预期的命令 ${command}`);
    });

    const wrapper = mountSurface();
    await waitFor(() => find(wrapper, "doc-viewer"));

    expect(find(wrapper, "doc-viewer")).toBe(true);
    expect(find(wrapper, "office-pdf-viewer")).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith("office_convert_to_pdf", expect.anything());
  });

  it("转换失败：回落原生 viewer，并把原因推进通知", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "office_convert_info") return { available: true, path: "/usr/bin/soffice", source: "path" };
      if (command === "office_convert_to_pdf") throw new Error("LibreOffice 转换超时（120s）");
      throw new Error(`未预期的命令 ${command}`);
    });

    const wrapper = mountSurface();
    await waitFor(() => find(wrapper, "doc-viewer"));

    expect(find(wrapper, "doc-viewer")).toBe(true);
    expect(find(wrapper, "office-pdf-viewer")).toBe(false);
    // 回落之后界面上看不出发生过什么，所以原因必须进通知。
    const notices = officePdfNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0].detail).toContain("转换超时");
  });

  it("浏览器预览态：拿不到 soffice 事实，默认原生 viewer", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      // 浏览器预览态 hasHostCommands() 为 false，ensure() 直接返回，不会发 office_convert_info。
      throw new Error(`本用例不应调用 ${command}`);
    });

    // 必须在 mount 之前把运行时切成 browser-preview：ensure() 在 onMounted 里读它，
    // mountSurface() 默认会先设成 server，晚了一步就白调一次。
    overrideRuntime("browser-preview");
    const wrapper = mount(PreviewSurface, { props: { tab: docxTab() } });
    await waitFor(() => find(wrapper, "doc-viewer"));

    expect(find(wrapper, "doc-viewer")).toBe(true);
    expect(find(wrapper, "office-pdf-viewer")).toBe(false);
    await settle();
    expect(invokeMock).not.toHaveBeenCalledWith("office_convert_info", expect.anything());
  });
});
