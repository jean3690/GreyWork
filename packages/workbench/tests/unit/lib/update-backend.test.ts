// 版本比较是「有没有新版」判定的唯一依据，误判会漏报或误报更新，值得钉死。
// check()/currentVersion() 的三态分流也在这里钉住：桌面与服务端都走 manual，
// 只有浏览器预览态 unsupported —— 服务端态谎报「需要桌面版」是修过的 bug。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hostIpc = vi.hoisted(() => ({
  hasHostCommands: vi.fn<() => boolean>(() => true),
  runtimeMode: vi.fn<() => string>(() => "server"),
  hostVersion: vi.fn<() => string | null>(() => "0.3.0"),
  invoke: vi.fn<(command: string, ...args: unknown[]) => Promise<unknown>>(async () => null),
}));

vi.mock("@greywork/host-ipc", () => hostIpc);

const tauriApp = vi.hoisted(() => ({ getVersion: vi.fn(async () => "9.9.9-desktop") }));

vi.mock("@tauri-apps/api/app", () => tauriApp);

import { isNewerVersion, updateBackend, type LatestRelease } from "@/lib/update-backend";

/** GitHub 最新 Release 的桩返回；版本号由用例覆盖。 */
function release(version: string): LatestRelease {
  return {
    version,
    tag: `v${version}`,
    name: version,
    notes: "- 修复若干问题",
    url: `https://github.com/jean3690/GreyWork/releases/tag/v${version}`,
    publishedAt: "2026-09-20T00:00:00Z",
    prerelease: false,
  };
}

beforeEach(() => {
  hostIpc.hasHostCommands.mockReturnValue(true);
  hostIpc.runtimeMode.mockReturnValue("server");
  hostIpc.hostVersion.mockReturnValue("0.3.0");
  hostIpc.invoke.mockReset().mockResolvedValue(release("0.4.0"));
  tauriApp.getVersion.mockReset().mockResolvedValue("9.9.9-desktop");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isNewerVersion", () => {
  it("逐段数值比较，主/次/修订任一更大即为新", () => {
    expect(isNewerVersion("0.2.0", "0.1.1")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.1.2", "0.1.1")).toBe(true);
  });

  it("相等或更旧不算新", () => {
    expect(isNewerVersion("0.1.1", "0.1.1")).toBe(false);
    expect(isNewerVersion("0.1.0", "0.1.1")).toBe(false);
    expect(isNewerVersion("1.9.9", "2.0.0")).toBe(false);
  });

  it("缺段按 0 补齐（0.2 视作 0.2.0）", () => {
    expect(isNewerVersion("0.2", "0.2.0")).toBe(false);
    expect(isNewerVersion("0.2.1", "0.2")).toBe(true);
  });

  it("预发布后缀不参与比较（只看数字段）", () => {
    expect(isNewerVersion("0.2.0-beta.1", "0.2.0")).toBe(false);
    expect(isNewerVersion("0.3.0-rc.1", "0.2.0")).toBe(true);
  });

  it("空/非法版本保守判 false，不误报有更新", () => {
    expect(isNewerVersion("", "0.1.0")).toBe(false);
    expect(isNewerVersion("latest", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.2.0", "")).toBe(false);
  });
});

describe("updateBackend · 三态分流", () => {
  it("服务端态：currentVersion 取宿主版本，check 走 manual 且真的比出版本差", async () => {
    await expect(updateBackend.currentVersion()).resolves.toBe("0.3.0");
    expect(tauriApp.getVersion).not.toHaveBeenCalled();

    const status = await updateBackend.check();
    expect(status.mode).toBe("manual");
    expect(status.hasUpdate).toBe(true);
    expect(status.currentVersion).toBe("0.3.0");
    expect(status.version).toBe("0.4.0");
    expect(hostIpc.invoke).toHaveBeenCalledWith("check_update");
  });

  it("服务端已是最新：manual 且无更新", async () => {
    hostIpc.invoke.mockResolvedValue(release("0.3.0"));

    const status = await updateBackend.check();
    expect(status.mode).toBe("manual");
    expect(status.hasUpdate).toBe(false);
  });

  it("桌面态：currentVersion 取 Tauri 版本，不走 hostVersion", async () => {
    hostIpc.runtimeMode.mockReturnValue("desktop");

    await expect(updateBackend.currentVersion()).resolves.toBe("9.9.9-desktop");
    expect(hostIpc.hostVersion).not.toHaveBeenCalled();
  });

  it("浏览器预览态：check 报 unsupported，不发起命令", async () => {
    hostIpc.hasHostCommands.mockReturnValue(false);
    hostIpc.runtimeMode.mockReturnValue("browser-preview");

    const status = await updateBackend.check();
    expect(status.mode).toBe("unsupported");
    expect(hostIpc.invoke).not.toHaveBeenCalled();
    expect(tauriApp.getVersion).not.toHaveBeenCalled();
  });
});
