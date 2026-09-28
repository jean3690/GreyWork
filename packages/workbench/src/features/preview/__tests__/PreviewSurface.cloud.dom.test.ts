/**
 * 云端 Office 接进预览区的可观察行为。
 *
 * 决策矩阵本身在 `tests/unit/lib/office-preview.test.ts`（纯函数，不需要挂载）。这里补的是
 * 矩阵答不了的那半：选中云端之后**真的**换了 viewer、`office_preview_open` 回的可嵌入地址
 * 真的进了 iframe、以及最要紧的一条 —— 任一环节失败都**回落到本地 viewer 并说明原因**，
 * 绝不出现「配了云端反而打不开」。
 *
 * provider 夹具只带环境变量**名**（`credentialEnv`），不带任何密钥值：凭证由宿主从环境变量解析，
 * 渲染端从头到尾只递变量名。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import type { OfficeProviderConfig } from "@greywork/shell";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import PreviewSurface from "@/features/preview/PreviewSurface.vue";
import { useNoticeStore } from "@/stores/notice";
import { useSettingsStore } from "@/stores/settings";
import type { PreviewTab } from "@/stores/preview";

const invokeMock = vi.mocked(invoke);

const RECIPE = {
  method: "POST" as const,
  url: "https://docs.example.com/upload",
  body: "multipart" as const,
  viewUrlPointer: "/data/url",
};

function provider(overrides: Partial<OfficeProviderConfig> = {}): OfficeProviderConfig {
  return {
    id: "custom",
    name: "自建文档服务",
    family: "office",
    kind: "custom",
    enabled: true,
    recipe: RECIPE,
    credentialEnv: "DOCS_TOKEN",
    ...overrides,
  };
}

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

/**
 * viewer 都是 `defineAsyncComponent`（重包不进主 chunk），动态 import 要跨若干宏任务才落定，
 * 固定轮数会随机器快慢飘。等条件，超时了也让断言去报真正缺的那个元素。
 */
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

function overrideRuntime(mode: "desktop" | "server" | "browser-preview"): void {
  (window as unknown as Record<string, unknown>).__GREYWORK_RUNTIME__ = mode;
}

/** 桌面态 + 注册 provider + 挂载预览区。 */
function mountSurface(providers: readonly OfficeProviderConfig[] = [], tab: PreviewTab = docxTab()): VueWrapper {
  overrideRuntime("desktop");
  const settings = useSettingsStore();
  for (const entry of providers) settings.upsertServiceProvider(entry);
  return mount(PreviewSurface, { props: { tab } });
}

const find = (wrapper: VueWrapper, testId: string): boolean => wrapper.find(`[data-testid="${testId}"]`).exists();
const cloudNotices = (): ReturnType<typeof useNoticeStore>["list"] =>
  useNoticeStore().list.filter((notice) => notice.key === "cloud-office-fallback:pv-1");

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  invokeMock.mockReset();
  // 本地 viewer 会自己去读文件；本文件不验那条链路，统一拒绝把它停在错误态
  // （`doc-viewer` 是 v-show，元素仍在 DOM 里，正是「本地 viewer 挂上了」的判据）。
  invokeMock.mockRejectedValue(new Error("本用例不提供本地内容"));
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__GREYWORK_RUNTIME__;
});

describe("预览区的云端 Office 分支", () => {
  it("没配 provider：走本地 viewer，且一个云端命令都不发", async () => {
    const wrapper = mountSurface();
    await waitFor(() => find(wrapper, "doc-viewer"));

    expect(find(wrapper, "doc-viewer")).toBe(true);
    expect(find(wrapper, "cloud-office-frame")).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith("office_preview_open", expect.anything());
  });

  it("配好 provider：顶掉本地 viewer，把命令回的可嵌入地址交给 iframe", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "office_preview_open") return { url: "https://view.example.com/d/abc", filename: "report.docx" };
      throw new Error(`未预期的命令 ${command}`);
    });

    const wrapper = mountSurface([provider()]);
    await waitFor(() => find(wrapper, "cloud-office-frame"));

    expect(wrapper.find('[data-testid="cloud-office-frame"]').attributes("src")).toBe("https://view.example.com/d/abc");
    // 传递的是路径 + 配方 + 环境变量名；字节和密钥都不经渲染端。
    expect(invokeMock).toHaveBeenCalledWith("office_preview_open", {
      path: "/work/report.docx",
      recipe: RECIPE,
      credentialEnv: "DOCS_TOKEN",
      headers: null,
    });
    expect(find(wrapper, "doc-viewer")).toBe(false);
  });

  it("宿主拒绝：回落本地 viewer，并把原因推进通知", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "office_preview_open") throw new Error("凭证环境变量 DOCS_TOKEN 未设置");
      throw new Error(`未预期的命令 ${command}`);
    });

    const wrapper = mountSurface([provider()]);
    await waitFor(() => find(wrapper, "doc-viewer"));

    expect(find(wrapper, "doc-viewer")).toBe(true);
    expect(find(wrapper, "cloud-office-frame")).toBe(false);
    // 回落之后界面上看不出发生过什么，所以原因必须进通知。
    const notices = cloudNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0].detail).toContain("DOCS_TOKEN");
  });

  // 宿主 CSP 只放行白名单里的 origin，不在表里就是 iframe 白屏且控制台之外看不到报错。
  // 所以「拿到的地址不可内嵌」必须回落并把是哪个域名说出来，而不是让 iframe 空着。
  it("返回的地址不在宿主可内嵌白名单里：回落本地 viewer，通知点名该 origin", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "office_host_info")
        return { embeddableFrameOrigins: ["https://allowed.example.com"], envPresent: [], envMissing: [] };
      if (command === "office_preview_open") return { url: "https://blocked.example.com/d/abc", filename: "report.docx" };
      throw new Error(`未预期的命令 ${command}`);
    });

    const wrapper = mountSurface([provider()]);
    await waitFor(() => find(wrapper, "doc-viewer"));

    expect(find(wrapper, "cloud-office-frame")).toBe(false);
    const notices = cloudNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0].detail).toContain("blocked.example.com");
    expect(notices[0].detail).toContain("allowed.example.com");
  });

  it("返回的地址在白名单里：正常内嵌", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "office_host_info") return { embeddableFrameOrigins: ["https://view.example.com"], envPresent: [], envMissing: [] };
      if (command === "office_preview_open") return { url: "https://view.example.com/d/abc", filename: "report.docx" };
      throw new Error(`未预期的命令 ${command}`);
    });

    const wrapper = mountSurface([provider()]);
    await waitFor(() => find(wrapper, "cloud-office-frame"));

    expect(wrapper.find('[data-testid="cloud-office-frame"]').attributes("src")).toBe("https://view.example.com/d/abc");
  });

  it("白名单取不到（查询失败）：不拦预览，照常内嵌", async () => {
    // 一次查询失败不该让云端预览全不可用 —— 宁可放行一次让 CSP 去拦。
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "office_host_info") throw new Error("宿主暂时不可用");
      if (command === "office_preview_open") return { url: "https://anything.example.com/d/abc", filename: "report.docx" };
      throw new Error(`未预期的命令 ${command}`);
    });

    const wrapper = mountSurface([provider()]);
    await waitFor(() => find(wrapper, "cloud-office-frame"));

    expect(wrapper.find('[data-testid="cloud-office-frame"]').attributes("src")).toBe("https://anything.example.com/d/abc");
  });

  it("回落后不反复重试：同一 tab 只通知一次，也不再发云端命令", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "office_preview_open") throw new Error("连接超时");
      throw new Error(`未预期的命令 ${command}`);
    });

    const wrapper = mountSurface([provider()]);
    await waitFor(() => find(wrapper, "doc-viewer"));
    const callsAfterFallback = invokeMock.mock.calls.filter(([command]) => command === "office_preview_open").length;

    // 让 tab 走一次 revision 变更（等同外部唤起重载）：已回落过的 tab 不该再试云端。
    await wrapper.setProps({ tab: { ...docxTab(), revision: 2 } });
    await settle();

    expect(cloudNotices()).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([command]) => command === "office_preview_open")).toHaveLength(callsAfterFallback);
  });

  it("只有开关没配方：不算配好，照走本地", async () => {
    const wrapper = mountSurface([provider({ recipe: undefined })]);
    await waitFor(() => find(wrapper, "doc-viewer"));

    expect(find(wrapper, "doc-viewer")).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith("office_preview_open", expect.anything());
  });
});
