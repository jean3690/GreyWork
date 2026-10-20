import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type * as GreyworkCore from "@greywork/core";

const mocks = vi.hoisted(() => ({
  pluginWriteText: vi.fn(() => Promise.resolve()),
  pluginReadText: vi.fn(() => Promise.resolve("")),
  invoke: vi.fn<(command: string, ...args: unknown[]) => Promise<unknown>>(() => Promise.resolve()),
  listen: vi.fn(),
  readImage: vi.fn(),
  getVersion: vi.fn(() => Promise.resolve("1.2.3")),
  homeDir: vi.fn(() => Promise.resolve("/home/tauri")),
  onDragDropEvent: vi.fn<(handler: (event: { payload: unknown }) => void) => Promise<() => void>>(),
  tauriWindow: {
    label: "main",
    minimize: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    toggleMaximize: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    close: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    isMaximized: vi.fn<() => Promise<boolean>>(() => Promise.resolve(false)),
    show: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    scaleFactor: vi.fn<() => Promise<number>>(() => Promise.resolve(2)),
    startDragging: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    onResized: vi.fn<(cb: () => void) => Promise<() => void>>(() => Promise.resolve(() => {})),
    onFocusChanged: vi.fn<(cb: (event: { payload: boolean }) => void) => Promise<() => void>>(() => Promise.resolve(() => {})),
    onCloseRequested: vi.fn<(cb: (event: { preventDefault: () => void }) => void) => Promise<() => void>>(() => Promise.resolve(() => {})),
  },
}));

vi.mock("@greywork/core", async (importOriginal) => ({
  ...(await importOriginal<typeof GreyworkCore>()),
}));
vi.mock("../../src/invoke", () => ({ invoke: mocks.invoke }));
vi.mock("../../src/events", () => ({ listen: mocks.listen }));

import {
  authorizeDroppedPaths,
  closeGuardHost,
  hasNativeShell,
  hasWindowControls,
  hostApp,
  hostBrowser,
  hostClipboard,
  hostDragDrop,
  hostNotify,
  hostPicker,
  hostPlugins,
  hostTray,
  hostWindow,
} from "../../src/shell";

interface ClipboardBridge {
  writeText: Mock;
  readText: Mock;
  readImagePng: Mock;
}
function stubElectron(clipboard: ClipboardBridge | null): void {
  const shell = clipboard ? { window: {}, clipboard } : undefined;
  vi.stubGlobal("window", shell ? { __GREYWORK_SHELL__: shell } : {});
}

beforeEach(() => {
  mocks.pluginWriteText.mockClear();
  mocks.pluginReadText.mockClear();
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.onDragDropEvent.mockReset();
  mocks.readImage.mockReset();
  mocks.getVersion.mockReset().mockResolvedValue("1.2.3");
  mocks.homeDir.mockReset().mockResolvedValue("/home/tauri");
  mocks.listen.mockReset().mockResolvedValue(() => {});
  for (const method of [
    mocks.tauriWindow.minimize,
    mocks.tauriWindow.toggleMaximize,
    mocks.tauriWindow.close,
    mocks.tauriWindow.isMaximized,
    mocks.tauriWindow.show,
    mocks.tauriWindow.scaleFactor,
    mocks.tauriWindow.startDragging,
  ]) {
    method.mockClear();
  }
  // 回调型：测试会覆盖 mockImplementation，重置回默认（返回解绑函数）。
  mocks.tauriWindow.onResized.mockReset().mockImplementation(() => Promise.resolve(() => {}));
  mocks.tauriWindow.onFocusChanged.mockReset().mockImplementation(() => Promise.resolve(() => {}));
  mocks.tauriWindow.onCloseRequested.mockReset().mockImplementation(() => Promise.resolve(() => {}));
  vi.unstubAllGlobals();
});

describe("hasWindowControls", () => {
  it("Electron bridge 存在为真", () => {
    stubElectron({ writeText: vi.fn(), readText: vi.fn(), readImagePng: vi.fn() });
    expect(hasWindowControls()).toBe(true);
  });

  it("都没有为假（纯服务端 / 浏览器态）", () => {
    vi.stubGlobal("window", {});
    expect(hasWindowControls()).toBe(false);
  });
});

describe("hostClipboard 按运行时选后端", () => {
  it("Electron：走主进程 bridge，不碰插件", async () => {
    const bridge: ClipboardBridge = {
      writeText: vi.fn(() => Promise.resolve()),
      readText: vi.fn(() => Promise.resolve("x")),
      readImagePng: vi.fn(() => Promise.resolve(null)),
    };
    stubElectron(bridge);

    await hostClipboard().writeText("hi");

    expect(bridge.writeText).toHaveBeenCalledWith("hi");
    expect(mocks.pluginWriteText).not.toHaveBeenCalled();
  });

  it("浏览器态：走 Web API，不碰插件", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await hostClipboard().writeText("hi");

    expect(writeText).toHaveBeenCalledWith("hi");
    expect(mocks.pluginWriteText).not.toHaveBeenCalled();
  });
});

interface BrowserBridge {
  open: Mock;
  setBounds: Mock;
  setVisible: Mock;
  navigate: Mock;
  back: Mock;
  forward: Mock;
  reload: Mock;
  stop: Mock;
  close: Mock;
  onState: Mock;
}

describe("hostBrowser 按运行时选后端", () => {
  it("无宿主（纯 server / 浏览器态）返回 null", () => {
    vi.stubGlobal("window", {});
    expect(hostBrowser()).toBeNull();
  });

  it("Electron：委派给 bridge.browser，不碰 invoke", async () => {
    const browser: BrowserBridge = {
      open: vi.fn(() => Promise.resolve()),
      setBounds: vi.fn(() => Promise.resolve()),
      setVisible: vi.fn(() => Promise.resolve()),
      navigate: vi.fn(() => Promise.resolve()),
      back: vi.fn(() => Promise.resolve()),
      forward: vi.fn(() => Promise.resolve()),
      reload: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
      onState: vi.fn(() => () => {}),
    };
    vi.stubGlobal("window", { __GREYWORK_SHELL__: { window: {}, browser } });

    const host = hostBrowser();
    expect(host).not.toBeNull();
    await host?.open("https://e.com", { x: 1, y: 2, width: 3, height: 4 });

    expect(browser.open).toHaveBeenCalledWith("https://e.com", { x: 1, y: 2, width: 3, height: 4 });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  // 命令名 / 参数名必须和宿主 browser.rs 的 browser_* 一一对应，漂移了只有运行时才炸。
});

describe("hasNativeShell（桌面专属命令的守卫）", () => {
  it("Electron bridge 存在为真", () => {
    stubElectron({ writeText: vi.fn(), readText: vi.fn(), readImagePng: vi.fn() });
    expect(hasNativeShell()).toBe(true);
  });

  it("纯服务端 / 浏览器态为假", () => {
    vi.stubGlobal("window", {});
    expect(hasNativeShell()).toBe(false);
  });
});

describe("hostWindow 按运行时选后端", () => {
  it("Electron：show 为空操作、scaleFactor 取 devicePixelRatio", async () => {
    vi.stubGlobal("window", {
      __GREYWORK_SHELL__: { window: { label: "main", platform: "linux" } },
      devicePixelRatio: 3,
    });
    const host = hostWindow();
    expect(host).not.toBeNull();
    expect(host?.platform).toBe("linux");
    await expect(host?.show()).resolves.toBeUndefined();
    await expect(host?.scaleFactor()).resolves.toBe(3);
  });
});

describe("hostApp 应用面", () => {
  it("无原生宿主返回 null", () => {
    vi.stubGlobal("window", {});
    expect(hostApp()).toBeNull();
  });

  it("Electron：revealPath / openPath 委派 bridge", async () => {
    const revealPath = vi.fn(() => Promise.resolve());
    const openPath = vi.fn(() => Promise.resolve());
    vi.stubGlobal("window", { __GREYWORK_SHELL__: { window: {}, app: { revealPath, openPath } } });
    const app = hostApp();
    await app?.revealPath("/a/b");
    await app?.openPath("/a/b");
    expect(revealPath).toHaveBeenCalledWith("/a/b");
    expect(openPath).toHaveBeenCalledWith("/a/b");
  });
});

describe("hostDragDrop", () => {
  it("Electron / 浏览器返回 null（走 HTML5 拖放）", () => {
    vi.stubGlobal("window", { __GREYWORK_SHELL__: { window: {} } });
    expect(hostDragDrop()).toBeNull();
    vi.stubGlobal("window", {});
    expect(hostDragDrop()).toBeNull();
  });
});

describe("authorizeDroppedPaths", () => {
  it("服务端态：把路径声明给宿主（命令名与入参形状与 Rust 侧对齐）", async () => {
    vi.stubGlobal("window", { __GREYWORK_RUNTIME__: "server" });
    await authorizeDroppedPaths(["/tmp/a.txt", "/tmp/b.png"]);
    expect(mocks.invoke).toHaveBeenCalledWith("fs_authorize_drop_paths", {
      paths: ["/tmp/a.txt", "/tmp/b.png"],
    });
  });

  it("空路径不发命令", async () => {
    vi.stubGlobal("window", { __GREYWORK_RUNTIME__: "server" });
    await authorizeDroppedPaths([]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("浏览器预览态：静默跳过（此态也拿不到磁盘路径）", async () => {
    vi.stubGlobal("window", {});
    await authorizeDroppedPaths(["/tmp/a.txt"]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("授权失败只告警不抛：让后续读取报自己的错，而不是吞掉整次拖放", async () => {
    vi.stubGlobal("window", { __GREYWORK_RUNTIME__: "server" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.invoke.mockRejectedValueOnce(new Error("命令 fs_authorize_drop_paths 在服务端不可用"));
    await expect(authorizeDroppedPaths(["/tmp/a.txt"])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("hostPicker 按运行时选后端", () => {
  /** Electron bridge 桩：`runtime` 非空时同时给出运行时覆盖（服务端态才会发授权命令）。 */
  function stubElectronPicker(picker: { openFiles: Mock; openDirectory: Mock }, runtime?: string): void {
    vi.stubGlobal("window", {
      ...(runtime ? { __GREYWORK_RUNTIME__: runtime } : {}),
      __GREYWORK_SHELL__: { window: {}, picker },
    });
  }

  it("纯服务端 / 浏览器返回 null", () => {
    vi.stubGlobal("window", {});
    expect(hostPicker()).toBeNull();
  });

  it("Electron：委派 bridge.picker（预览态不发文授权命令）", async () => {
    const openFiles = vi.fn(() => Promise.resolve(["/a"]));
    const openDirectory = vi.fn(() => Promise.resolve("/ws"));
    stubElectronPicker({ openFiles, openDirectory });
    const picker = hostPicker();
    await expect(picker?.pickFiles({ purpose: "media", multiple: true })).resolves.toEqual(["/a"]);
    await expect(picker?.pickWorkspaceFolder()).resolves.toBe("/ws");
    expect(openFiles).toHaveBeenCalledWith({ purpose: "media", multiple: true });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("Electron + 服务端态：选中的路径先声明给宿主，回的是宿主给的规范路径", async () => {
    const openFiles = vi.fn(() => Promise.resolve(["/a/link.txt"]));
    const openDirectory = vi.fn(() => Promise.resolve("/ws/../ws"));
    stubElectronPicker({ openFiles, openDirectory }, "server");

    mocks.invoke.mockResolvedValueOnce(["/real.txt"]);
    await expect(hostPicker()?.pickFiles({ purpose: "media", multiple: true })).resolves.toEqual(["/real.txt"]);
    expect(mocks.invoke).toHaveBeenCalledWith("fs_authorize_picked_paths", { paths: ["/a/link.txt"] });

    mocks.invoke.mockResolvedValueOnce(["/ws"]);
    await expect(hostPicker()?.pickWorkspaceFolder()).resolves.toBe("/ws");
    expect(mocks.invoke).toHaveBeenCalledWith("fs_authorize_picked_paths", { paths: ["/ws/../ws"] });
  });

  it("Electron + 服务端态：授权失败回落原路径（让后续读取报真实原因）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubElectronPicker({ openFiles: vi.fn(), openDirectory: vi.fn(() => Promise.resolve("/ws")) }, "server");
    mocks.invoke.mockRejectedValueOnce(new Error("命令 fs_authorize_picked_paths 在服务端不可用"));
    await expect(hostPicker()?.pickWorkspaceFolder()).resolves.toBe("/ws");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("Electron：取消选择不发文授权命令", async () => {
    stubElectronPicker({ openFiles: vi.fn(() => Promise.resolve([])), openDirectory: vi.fn(() => Promise.resolve(null)) }, "server");
    await expect(hostPicker()?.pickWorkspaceFolder()).resolves.toBeNull();
    await expect(hostPicker()?.pickFiles({ purpose: "media", multiple: false })).resolves.toEqual([]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("hostNotify 系统通知面", () => {
  it("无原生壳返回 null（无桥即无通知面）", () => {
    vi.stubGlobal("window", {});
    expect(hostNotify()).toBeNull();
  });

  it("Electron：委派 bridge.notify.system，文案原样不加前缀", async () => {
    const system = vi.fn(() => Promise.resolve());
    vi.stubGlobal("window", { __GREYWORK_SHELL__: { window: {}, notify: { system } } });
    await hostNotify()?.send("自动化完成", "日报已生成");
    expect(system).toHaveBeenCalledWith("自动化完成", "日报已生成");
  });

  it("Electron 壳未接该分组时返回 null（渐进迁移期不崩）", () => {
    vi.stubGlobal("window", { __GREYWORK_SHELL__: { window: {} } });
    expect(hostNotify()).toBeNull();
  });
});

describe("hostPlugins 按运行时选后端", () => {
  it("纯服务端 / 浏览器返回 null", () => {
    vi.stubGlobal("window", {});
    expect(hostPlugins()).toBeNull();
  });

  it("Electron：委派 bridge.plugins", async () => {
    const notify = vi.fn(() => Promise.resolve({ title: "[p] t", body: "b" }));
    const openWindow = vi.fn(() => Promise.resolve());
    const closeWindow = vi.fn(() => Promise.resolve());
    vi.stubGlobal("window", { __GREYWORK_SHELL__: { window: {}, plugins: { notify, openWindow, closeWindow } } });
    const plugins = hostPlugins();
    await expect(plugins?.notify({ pluginId: "p", title: "t", body: "b" })).resolves.toEqual({ title: "[p] t", body: "b" });
    await plugins?.openWindow("p");
    await plugins?.closeWindow("p");
    expect(openWindow).toHaveBeenCalledWith("p");
    expect(closeWindow).toHaveBeenCalledWith("p");
  });
});

describe("hostWindow 各控制方法", () => {
  it("Electron：窗口控制委派 bridge，show/startDragging 为空操作", async () => {
    const w = {
      label: "main",
      minimize: vi.fn(() => Promise.resolve()),
      toggleMaximize: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
      isMaximized: vi.fn(() => Promise.resolve(true)),
      onResized: vi.fn(() => () => {}),
      onFocusChanged: vi.fn(() => () => {}),
    };
    vi.stubGlobal("window", { __GREYWORK_SHELL__: { window: w } });
    const host = hostWindow();
    expect(host?.label).toBe("main");
    await host?.minimize();
    await host?.toggleMaximize();
    await host?.close();
    await expect(host?.isMaximized()).resolves.toBe(true);
    await expect(host?.startDragging()).resolves.toBeUndefined();
    expect(w.minimize).toHaveBeenCalledTimes(1);
    expect(w.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(w.close).toHaveBeenCalledTimes(1);

    const offResized = await host?.onResized(vi.fn());
    const offFocus = await host?.onFocusChanged(vi.fn());
    offResized?.();
    offFocus?.();
    expect(w.onResized).toHaveBeenCalledTimes(1);
    expect(w.onFocusChanged).toHaveBeenCalledTimes(1);
  });

  it("无宿主返回 null", () => {
    vi.stubGlobal("window", {});
    expect(hostWindow()).toBeNull();
  });
});

describe("closeGuardHost 按运行时选后端", () => {
  it("无宿主返回 null", () => {
    vi.stubGlobal("window", {});
    expect(closeGuardHost()).toBeNull();
  });

  it("Electron：委派 bridge.window 的守卫通道", async () => {
    const w = {
      syncUnsavedChanges: vi.fn(() => Promise.resolve()),
      requestClose: vi.fn(() => Promise.resolve()),
      confirmExit: vi.fn(() => Promise.resolve()),
      onCloseRequested: vi.fn(() => () => {}),
      onExitRequested: vi.fn(() => () => {}),
    };
    vi.stubGlobal("window", { __GREYWORK_SHELL__: { window: w } });
    const guard = closeGuardHost();
    await guard?.syncUnsavedChanges(true);
    await guard?.requestClose();
    await guard?.confirmExit();
    await guard?.onCloseRequested(() => {});
    await guard?.onExitRequested(() => {});
    expect(w.syncUnsavedChanges).toHaveBeenCalledWith(true);
    expect(w.requestClose).toHaveBeenCalledTimes(1);
    expect(w.confirmExit).toHaveBeenCalledTimes(1);
    expect(w.onCloseRequested).toHaveBeenCalledTimes(1);
    expect(w.onExitRequested).toHaveBeenCalledTimes(1);
  });
});

describe("hostClipboard 读写图片/文本", () => {
  it("Electron：readText / readImagePng 委派 bridge", async () => {
    const readText = vi.fn(() => Promise.resolve("hi"));
    const readImagePng = vi.fn(() => Promise.resolve(new Uint8Array([1, 2])));
    vi.stubGlobal("window", { __GREYWORK_SHELL__: { window: {}, clipboard: { readText, readImagePng } } });
    const clip = hostClipboard();
    await expect(clip.readText()).resolves.toBe("hi");
    await expect(clip.readImagePng()).resolves.toEqual(new Uint8Array([1, 2]));
  });

  it("浏览器态：readText 走 Web API，readImagePng 无 read 时返回 null", async () => {
    const readText = vi.fn(() => Promise.resolve("web"));
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const clip = hostClipboard();
    await expect(clip.readText()).resolves.toBe("web");
    await expect(clip.readImagePng()).resolves.toBeNull();
  });

  it("浏览器态：readImagePng 经 clipboard.read 取图像项", async () => {
    const png = new Uint8Array([9]);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      clipboard: {
        read: () =>
          Promise.resolve([
            { types: ["text/plain"], getType: () => Promise.resolve(new Blob([])) },
            { types: ["image/png"], getType: () => Promise.resolve(new Blob([png], { type: "image/png" })) },
          ]),
      },
    });
    await expect(hostClipboard().readImagePng()).resolves.toEqual(png);
  });

  it("浏览器态：readImagePng 无图像项 / read 抛错时返回 null", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      clipboard: {
        read: () => Promise.resolve([{ types: ["text/plain"], getType: () => Promise.resolve(new Blob([])) }]),
      },
    });
    await expect(hostClipboard().readImagePng()).resolves.toBeNull();

    vi.stubGlobal("navigator", { clipboard: { read: () => Promise.reject(new Error("denied")) } });
    await expect(hostClipboard().readImagePng()).resolves.toBeNull();
  });
});

describe("hostApp 版本 / 主目录 / 外链 / 拖入路径", () => {
  it("Electron：委派 bridge.app", async () => {
    const app = {
      version: vi.fn(() => Promise.resolve("9.9.9")),
      homeDir: vi.fn(() => Promise.resolve("/home/x")),
      openExternal: vi.fn(() => Promise.resolve()),
      revealPath: vi.fn(() => Promise.resolve()),
      openPath: vi.fn(() => Promise.resolve()),
      pathForFile: vi.fn(() => "/a/b"),
    };
    vi.stubGlobal("window", { __GREYWORK_SHELL__: { window: {}, app } });
    const host = hostApp();
    await expect(host?.version()).resolves.toBe("9.9.9");
    await expect(host?.homeDir()).resolves.toBe("/home/x");
    await host?.openExternal("https://e.com");
    expect(host?.pathForDroppedFile(new File([], "f"))).toBe("/a/b");
  });

  it("Electron：pathForFile 空串归 null", () => {
    vi.stubGlobal("window", { __GREYWORK_SHELL__: { window: {}, app: { pathForFile: () => "" } } });
    expect(hostApp()?.pathForDroppedFile(new File([], "f"))).toBeNull();
  });
});

describe("hostTray 按运行时选后端", () => {
  it("无宿主返回 null", () => {
    vi.stubGlobal("window", {});
    expect(hostTray()).toBeNull();
  });

  it("Electron：委派 bridge.tray，onEvent 合并两个订阅", async () => {
    const offNew = vi.fn();
    const offSettings = vi.fn();
    const t = {
      available: vi.fn(() => Promise.resolve(true)),
      setCloseToTray: vi.fn(() => Promise.resolve()),
      setLabels: vi.fn(() => Promise.resolve()),
      onNewChat: vi.fn(() => offNew),
      onOpenSettings: vi.fn(() => offSettings),
    };
    vi.stubGlobal("window", { __GREYWORK_SHELL__: { window: {}, tray: t } });
    const tray = hostTray();
    const labels = { toggleWindow: "a", newChat: "b", settings: "c", quit: "d", hiddenHint: "e" };
    await expect(tray?.available()).resolves.toBe(true);
    await tray?.setCloseToTray(true);
    await tray?.setLabels(labels);
    const off = await tray?.onEvent({ newChat: vi.fn(), openSettings: vi.fn() });
    off?.();
    expect(t.setCloseToTray).toHaveBeenCalledWith(true);
    expect(t.setLabels).toHaveBeenCalledWith(labels);
    expect(offNew).toHaveBeenCalledTimes(1);
    expect(offSettings).toHaveBeenCalledTimes(1);
  });
});

describe("hostBrowser onState 订阅", () => {
  it("Electron：其余控制方法委派 bridge.browser", async () => {
    const browser = {
      setBounds: vi.fn(() => Promise.resolve()),
      setVisible: vi.fn(() => Promise.resolve()),
      navigate: vi.fn(() => Promise.resolve()),
      back: vi.fn(() => Promise.resolve()),
      forward: vi.fn(() => Promise.resolve()),
      reload: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
      onState: vi.fn(() => () => {}),
    };
    vi.stubGlobal("window", { __GREYWORK_SHELL__: { window: {}, browser } });
    const host = hostBrowser();
    await host?.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    await host?.setVisible(true);
    await host?.navigate("https://e.com");
    await host?.back();
    await host?.forward();
    await host?.reload();
    await host?.stop();
    await host?.close();
    expect(browser.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1, height: 1 });
    expect(browser.navigate).toHaveBeenCalledWith("https://e.com");
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("Electron：委派 bridge.browser.onState", async () => {
    const onState = vi.fn(() => () => {});
    vi.stubGlobal("window", { __GREYWORK_SHELL__: { window: {}, browser: { onState } } });
    const handler = vi.fn();
    await hostBrowser()?.onState(handler);
    expect(onState).toHaveBeenCalledWith(handler);
  });
});
