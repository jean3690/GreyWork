/**
 * 内嵌浏览器外壳（features/preview/BrowserViewer）：
 *
 * - 挂载即 browser_open 打开子 webview 并对齐到槽位；
 * - 宿主 browser:state 回推要更新地址栏 / tab 名 / 前进后退可用性；
 * - 地址栏回车走归一化导航，同址是 no-op；
 * - 有宿主弹层时把 webview 藏起来（原生层会盖住弹层）；
 * - 卸载时 tab 还在只藏不关（切回不丢状态），tab 没了才销毁；
 * - 加载超 15s 给「卡住」逃生口，state 回推 loading=false 即解除。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import type { BrowserStateEvent } from "@/lib/browser-backend";

const h = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, ...args: unknown[]) => Promise<void>>(async () => undefined),
  listen: vi.fn<(event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>>(async () => () => {}),
  stateHandler: null as null | ((event: { payload: BrowserStateEvent }) => void),
  store: {
    available: true,
    collapsed: false,
    effectiveWidthPx: 480,
    tabs: [] as Array<{ kind: string }>,
    setName: vi.fn(),
  },
}));

vi.mock("@greywork/host-ipc", () => ({
  hasHostCommands: () => true,
  invoke: h.invoke,
  listen: (event: string, handler: (event: { payload: unknown }) => void) => {
    h.stateHandler = handler;
    return h.listen(event, handler);
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async () => () => {},
  }),
}));

vi.mock("@/stores/preview", () => ({
  usePreviewStore: () => h.store,
}));

vi.mock("vue-router", () => ({
  useRoute: () => ({ fullPath: "/chat" }),
}));

import { i18n } from "@/i18n";
import BrowserViewer from "@/features/preview/BrowserViewer.vue";
import type { PreviewTab } from "@/stores/preview";

function browserTab(partial: Partial<PreviewTab> = {}): PreviewTab {
  return {
    id: "pv-9",
    path: "https://example.com",
    name: "example.com",
    kind: "browser",
    source: "web",
    revision: 0,
    ...partial,
  };
}

function pushState(payload: BrowserStateEvent): void {
  h.stateHandler?.({ event: "browser:state", payload, id: 1 } as { payload: BrowserStateEvent });
}

const mounted: VueWrapper[] = [];

beforeEach(() => {
  h.invoke.mockReset().mockResolvedValue(undefined);
  h.listen.mockReset().mockResolvedValue(() => {});
  h.stateHandler = null;
  h.store.available = true;
  h.store.collapsed = false;
  h.store.tabs = [];
  h.store.setName.mockReset();
  // happy-dom 的 ResizeObserver 行为不稳定，测试只关心「有观察者被注册」。
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
  i18n.global.locale.value = "zh-CN";
});

afterEach(() => {
  while (mounted.length) {
    try {
      mounted.pop()?.unmount();
    } catch {
      // 用例内已显式卸载：忽略。
    }
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function render(tab: PreviewTab = browserTab()): Promise<VueWrapper> {
  const wrapper = mount(BrowserViewer, { props: { tab }, global: { plugins: [i18n] } });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

describe("BrowserViewer", () => {
  it("挂载即 browser_open 打开子 webview（槽位未布局时是 0 矩形）", async () => {
    await render();
    expect(h.invoke).toHaveBeenCalledWith("browser_open", {
      url: "https://example.com",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });

  it("宿主状态回推：更新地址栏、tab 名与前进后退可用性", async () => {
    const wrapper = await render();
    pushState({
      url: "https://example.com/page2",
      title: "第二页",
      loading: false,
      canGoBack: true,
      canGoForward: false,
    });
    await flushPromises();

    expect((wrapper.find('[data-testid="browser-url"]').element as HTMLInputElement).value).toBe("https://example.com/page2");
    expect(h.store.setName).toHaveBeenCalledWith("pv-9", "第二页");
    expect((wrapper.find('[data-testid="browser-back"]').element as HTMLButtonElement).disabled).toBe(false);
    expect((wrapper.find('[data-testid="browser-forward"]').element as HTMLButtonElement).disabled).toBe(true);
  });

  it("地址栏回车导航走归一化；同址回车是 no-op", async () => {
    const wrapper = await render();
    const input = wrapper.find('[data-testid="browser-url"]');
    await input.setValue("localhost:5173");
    await input.trigger("keydown.enter");
    await flushPromises();
    expect(h.invoke).toHaveBeenCalledWith("browser_navigate", { url: "http://localhost:5173" });

    const navigates = h.invoke.mock.calls.filter(([command]) => command === "browser_navigate").length;
    await input.setValue("https://example.com");
    await input.trigger("keydown.enter");
    await flushPromises();
    expect(h.invoke.mock.calls.filter(([command]) => command === "browser_navigate")).toHaveLength(navigates);
  });

  it("有宿主弹层时隐藏 webview", async () => {
    await render();
    h.invoke.mockClear();
    document.body.innerHTML = '<div role="dialog"><p>确认吗</p></div>';
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledWith("browser_set_visible", { visible: false }));
  });

  it("卸载：tab 还在只藏不关，tab 没了才销毁", async () => {
    const kept = await render();
    h.store.tabs = [browserTab()];
    kept.unmount();
    await flushPromises();
    expect(h.invoke).toHaveBeenCalledWith("browser_set_visible", { visible: false });
    expect(h.invoke).not.toHaveBeenCalledWith("browser_close");

    h.invoke.mockClear();
    const closed = await render();
    h.store.tabs = [];
    closed.unmount();
    await flushPromises();
    expect(h.invoke).toHaveBeenCalledWith("browser_close");
  });

  it("加载超 15s 显示卡住逃生口，loading 解除即消失", async () => {
    vi.useFakeTimers();
    const wrapper = await render();
    pushState({ url: "https://slow.example", title: "", loading: true, canGoBack: false, canGoForward: false });

    vi.advanceTimersByTime(15_000);
    await flushPromises();
    expect(wrapper.find('[data-testid="browser-stuck"]').exists()).toBe(true);

    pushState({ url: "https://slow.example", title: "好了", loading: false, canGoBack: false, canGoForward: false });
    await flushPromises();
    expect(wrapper.find('[data-testid="browser-stuck"]').exists()).toBe(false);
  });
});
