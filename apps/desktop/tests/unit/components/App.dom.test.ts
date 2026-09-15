/**
 * 桌面外壳的拖放接线：订阅宿主 webview 拖放事件 → 落在预览工作台外的文件以 disk 源
 * 打开到预览面板；落在聊天附件区内的拖放必须让位（不开预览）；非 Tauri 环境静默降级。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import App from "../../../src/App.vue";

const h = vi.hoisted(() => ({
  inDropzone: vi.fn<() => Promise<boolean>>(),
  preview: { open: vi.fn<(path: string, name: string, source: string) => void>() },
  webview: vi.fn(),
  onDragDrop: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("@greywork/workbench", () => ({
  Shell: { name: "ShellStub", template: '<div data-testid="shell-stub" />' },
  isPhysicalPointInDropzone: () => h.inDropzone(),
  usePreviewStore: () => h.preview,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => h.webview(),
}));

interface DropEvent {
  payload: { type: string; position: { x: number; y: number }; paths: string[] };
}

function handler() {
  return h.onDragDrop.mock.calls[0][0] as (event: DropEvent) => Promise<void>;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.webview.mockReturnValue({ onDragDropEvent: h.onDragDrop });
  h.onDragDrop.mockResolvedValue(h.unlisten);
  h.inDropzone.mockResolvedValue(false);
});

describe("App 拖放接线", () => {
  it("挂载即订阅 webview 拖放，卸载时退订", async () => {
    const wrapper = mount(App);
    await flushPromises();

    expect(h.webview).toHaveBeenCalledTimes(1);
    expect(h.onDragDrop).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    expect(h.unlisten).toHaveBeenCalledTimes(1);
  });

  it("拖放落在预览工作台外：按磁盘源打开文件", async () => {
    const wrapper = mount(App);
    await flushPromises();

    await handler()({ payload: { type: "drop", position: { x: 10, y: 20 }, paths: ["/ws/src/a.ts"] } });
    await flushPromises();
    await wrapper.vm.$nextTick();

    expect(h.preview.open).toHaveBeenCalledWith("/ws/src/a.ts", "a.ts", "disk");
  });

  it("Windows 风格路径也能取到文件名", async () => {
    const wrapper = mount(App);
    await flushPromises();

    await handler()({ payload: { type: "drop", position: { x: 0, y: 0 }, paths: ["C:\\ws\\b.vue"] } });
    await flushPromises();
    await wrapper.vm.$nextTick();

    expect(h.preview.open).toHaveBeenCalledWith("C:\\ws\\b.vue", "b.vue", "disk");
  });

  it("落在聊天附件区内让位：不开预览", async () => {
    h.inDropzone.mockResolvedValue(true);
    const wrapper = mount(App);
    await flushPromises();

    await handler()({ payload: { type: "drop", position: { x: 5, y: 5 }, paths: ["/ws/c.md"] } });
    await flushPromises();
    await wrapper.vm.$nextTick();

    expect(h.preview.open).not.toHaveBeenCalled();
  });

  it("非 drop 事件忽略", async () => {
    mount(App);
    await flushPromises();

    await handler()({ payload: { type: "over", position: { x: 0, y: 0 }, paths: ["/ws/x"] } });
    await flushPromises();

    expect(h.preview.open).not.toHaveBeenCalled();
  });

  it("拖放无路径时忽略", async () => {
    mount(App);
    await flushPromises();

    await handler()({ payload: { type: "drop", position: { x: 0, y: 0 }, paths: [] } });
    await flushPromises();

    expect(h.preview.open).not.toHaveBeenCalled();
  });

  it("无 webview 宿主时静默降级：不订阅、不崩、卸载无忧", async () => {
    h.webview.mockImplementation(() => {
      throw new Error("浏览器 dev 没有 webview");
    });

    const wrapper = mount(App);
    await flushPromises();

    expect(h.onDragDrop).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(h.unlisten).not.toHaveBeenCalled();
  });
});
