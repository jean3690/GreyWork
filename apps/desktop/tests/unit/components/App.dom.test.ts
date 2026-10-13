/**
 * 桌面外壳的拖放接线：有原生拖放面（Tauri）时订阅宿主拖放事件 → 落在预览工作台外的文件
 * 以 disk 源打开到预览面板；落在聊天附件区内的拖放必须让位（不开预览）；无原生拖放面
 * （Electron / 浏览器）时回落 HTML5 drop。
 *
 * 两条路都要先把路径**声明给宿主**（`authorizeDroppedPaths`）—— Electron / 自托管服务端下
 * 宿主不知道用户拖过什么，不声明随后的读盘会被拒；Tauri 侧是空操作（它在 Rust 里授权）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import App from "../../../src/App.vue";

const h = vi.hoisted(() => ({
  inDropzone: vi.fn<() => Promise<boolean>>(),
  preview: { open: vi.fn<(path: string, name: string, source: string) => void>() },
  dragDrop: vi.fn(),
  onDragDrop: vi.fn(),
  unlisten: vi.fn(),
  pathForDroppedFile: vi.fn<(file: File) => string | null>(() => null),
  authorizeDroppedPaths: vi.fn<(paths: readonly string[]) => Promise<void>>(),
}));

vi.mock("@greywork/workbench", () => ({
  Shell: { name: "ShellStub", template: '<div data-testid="shell-stub" />' },
  // 登录门在这里是透传壳：它的分岔逻辑由 workbench 自己的 AuthGate.dom.test.ts 覆盖。
  AuthGate: { name: "AuthGateStub", template: "<div><slot /></div>" },
  isPhysicalPointInDropzone: () => h.inDropzone(),
  usePreviewStore: () => h.preview,
}));
vi.mock("@greywork/host-ipc", () => ({
  // 原生拖放面：非 null 即走宿主事件（Tauri），null 即回落 HTML5 drop。
  hostDragDrop: () => h.dragDrop(),
  hostApp: () => ({ pathForDroppedFile: (file: File) => h.pathForDroppedFile(file) }),
  authorizeDroppedPaths: (paths: readonly string[]) => h.authorizeDroppedPaths(paths),
}));

interface DropPayload {
  type: string;
  position: { x: number; y: number };
  paths: string[];
}

function handler() {
  // 门面 hostDragDrop().onDragDrop 已把 Tauri 事件的 payload 解包，回调直接收 payload。
  return h.onDragDrop.mock.calls[0][0] as (payload: DropPayload) => void;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.dragDrop.mockReturnValue({ onDragDrop: h.onDragDrop });
  h.onDragDrop.mockResolvedValue(h.unlisten);
  h.inDropzone.mockResolvedValue(false);
  h.pathForDroppedFile.mockReturnValue(null);
  h.authorizeDroppedPaths.mockResolvedValue(undefined);
});

describe("App 拖放接线", () => {
  it("挂载即订阅原生拖放，卸载时退订", async () => {
    const wrapper = mount(App);
    await flushPromises();

    expect(h.dragDrop).toHaveBeenCalledTimes(1);
    expect(h.onDragDrop).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    expect(h.unlisten).toHaveBeenCalledTimes(1);
  });

  it("拖放落在预览工作台外：按磁盘源打开文件", async () => {
    const wrapper = mount(App);
    await flushPromises();

    await handler()({ type: "drop", position: { x: 10, y: 20 }, paths: ["/ws/src/a.ts"] });
    await flushPromises();
    await wrapper.vm.$nextTick();

    expect(h.authorizeDroppedPaths).toHaveBeenCalledWith(["/ws/src/a.ts"]);
    expect(h.preview.open).toHaveBeenCalledWith("/ws/src/a.ts", "a.ts", "disk");
  });

  it("Windows 风格路径也能取到文件名", async () => {
    const wrapper = mount(App);
    await flushPromises();

    await handler()({ type: "drop", position: { x: 0, y: 0 }, paths: ["C:\\ws\\b.vue"] });
    await flushPromises();
    await wrapper.vm.$nextTick();

    expect(h.preview.open).toHaveBeenCalledWith("C:\\ws\\b.vue", "b.vue", "disk");
  });

  it("落在聊天附件区内让位：不开预览", async () => {
    h.inDropzone.mockResolvedValue(true);
    const wrapper = mount(App);
    await flushPromises();

    await handler()({ type: "drop", position: { x: 5, y: 5 }, paths: ["/ws/c.md"] });
    await flushPromises();
    await wrapper.vm.$nextTick();

    expect(h.authorizeDroppedPaths).not.toHaveBeenCalled();
    expect(h.preview.open).not.toHaveBeenCalled();
  });

  it("非 drop 事件忽略", async () => {
    mount(App);
    await flushPromises();

    await handler()({ type: "over", position: { x: 0, y: 0 }, paths: ["/ws/x"] });
    await flushPromises();

    expect(h.preview.open).not.toHaveBeenCalled();
  });

  it("拖放无路径时忽略", async () => {
    mount(App);
    await flushPromises();

    await handler()({ type: "drop", position: { x: 0, y: 0 }, paths: [] });
    await flushPromises();

    expect(h.preview.open).not.toHaveBeenCalled();
  });

  it("无原生拖放面时静默降级：不订阅、不崩、卸载无忧", async () => {
    h.dragDrop.mockReturnValue(null);

    const wrapper = mount(App);
    await flushPromises();

    expect(h.onDragDrop).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(h.unlisten).not.toHaveBeenCalled();
  });
});

// Electron / 浏览器态：无原生拖放面 → OS 拖放以 HTML5 drop 抵达 DOM；Electron 能从 File 取
// 磁盘路径开 disk 预览，落在聊天附件区内（data-attachment-dropzone）同样让位。
describe("App 拖放接线 · 无原生拖放面（HTML5 drop）", () => {
  function dropOn(target: EventTarget, file: File | null): void {
    const event = Object.assign(new Event("drop", { bubbles: true, cancelable: true }), {
      dataTransfer: { files: file ? [file] : [], types: ["Files"] },
    });
    target.dispatchEvent(event);
  }

  beforeEach(() => {
    h.dragDrop.mockReturnValue(null);
  });

  it("落在附件区外：经 webUtils 路径按 disk 源打开，不碰原生拖放", async () => {
    h.pathForDroppedFile.mockReturnValue("/ws/d.ts");
    mount(App);
    await flushPromises();

    dropOn(document.body, new File(["x"], "d.ts"));
    await flushPromises();

    expect(h.onDragDrop).not.toHaveBeenCalled();
    expect(h.pathForDroppedFile).toHaveBeenCalledTimes(1);
    expect(h.authorizeDroppedPaths).toHaveBeenCalledWith(["/ws/d.ts"]);
    expect(h.preview.open).toHaveBeenCalledWith("/ws/d.ts", "d.ts", "disk");
  });

  it("落在聊天附件区内：让位，不开预览", async () => {
    h.pathForDroppedFile.mockReturnValue("/ws/d.ts");
    mount(App);
    await flushPromises();

    const zone = document.createElement("div");
    zone.setAttribute("data-attachment-dropzone", "");
    document.body.appendChild(zone);
    dropOn(zone, new File(["x"], "d.ts"));
    await flushPromises();

    expect(h.preview.open).not.toHaveBeenCalled();
  });

  it("拿不到磁盘路径（浏览器态）：不开预览", async () => {
    h.pathForDroppedFile.mockReturnValue(null);
    mount(App);
    await flushPromises();

    dropOn(document.body, new File(["x"], "d.ts"));
    await flushPromises();

    expect(h.preview.open).not.toHaveBeenCalled();
  });
});
