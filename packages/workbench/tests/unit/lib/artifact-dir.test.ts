/**
 * 产物默认落盘的目录决策（lib/artifact-dir）：
 * 浏览器态不落盘 → null；桌面端优先激活工作区绑定的绝对路径，其次 store 默认根，
 * 两条都不成立 → null；文件名净化与文本/二进制分通道。invoke 完全 mock 掉，
 * 不碰任何真正的 host 通道。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@greywork/core";
import type * as ArtifactDirModule from "@/lib/artifact-dir";

const h = vi.hoisted(() => ({
  isTauri: vi.fn(),
  invoke: vi.fn(),
  activeWorkspaceId: vi.fn(),
  workspaceById: vi.fn(),
  ensureDir: vi.fn(),
  writeTextFile: vi.fn(),
  writeBinaryFile: vi.fn(),
}));

vi.mock("@greywork/core", async (importOriginal) => {
  const mod = await importOriginal<typeof CoreModule>();
  return { ...mod, isTauriRuntime: h.isTauri };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: () => ({ activeWorkspaceId: h.activeWorkspaceId(), workspaceById: h.workspaceById }),
}));
vi.mock("@/state/workspaceFiles", () => ({
  ensureDir: h.ensureDir,
  writeTextFile: h.writeTextFile,
  writeBinaryFile: h.writeBinaryFile,
}));

import { resolveArtifactsDir, saveArtifactToDisk } from "@/lib/artifact-dir";

const WORKSPACE_WORKSPACE_FOLDER = "/srv/projects/acme";

/** defaultRootPromise 是模块级缓存，按用例重载模块以隔离缓存状态。 */
async function fresh(): Promise<typeof ArtifactDirModule> {
  vi.resetModules();
  return await import("@/lib/artifact-dir");
}

function bindWorkspace(folder: string | undefined): void {
  h.activeWorkspaceId.mockReturnValue(folder === undefined ? null : "w1");
  h.workspaceById.mockImplementation((id: string | null) => (id === "w1" ? { id: "w1", folder } : undefined));
}

beforeEach(() => {
  h.isTauri.mockReset().mockReturnValue(true);
  h.invoke.mockReset().mockResolvedValue("/home/jean/.greyWork");
  h.activeWorkspaceId.mockReset().mockReturnValue(null);
  h.workspaceById.mockReset().mockReturnValue(undefined);
  h.ensureDir.mockReset().mockResolvedValue(undefined);
  h.writeTextFile.mockReset().mockResolvedValue(undefined);
  h.writeBinaryFile.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveArtifactsDir", () => {
  it("浏览器态直接 null，且不碰任何 host 通道", async () => {
    h.isTauri.mockReturnValue(false);
    bindWorkspace("/srv/projects/acme");

    await expect(resolveArtifactsDir()).resolves.toBeNull();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.ensureDir).not.toHaveBeenCalled();
  });

  it("激活工作区绑定绝对路径 → 落 <工作区>/artifacts，不再问默认根", async () => {
    bindWorkspace(WORKSPACE_WORKSPACE_FOLDER);

    await expect(resolveArtifactsDir()).resolves.toBe(`${WORKSPACE_WORKSPACE_FOLDER}/artifacts`);
    expect(h.ensureDir).toHaveBeenCalledWith(`${WORKSPACE_WORKSPACE_FOLDER}/artifacts`);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("未绑定工作区 → 用默认根（store_default_root + /artifacts）", async () => {
    const mod = await fresh();
    await expect(mod.resolveArtifactsDir()).resolves.toBe("/home/jean/.greyWork/artifacts");
    expect(h.invoke).toHaveBeenCalledWith("store_default_root");
  });

  it("工作区绑了相对路径（./…）→ 不算绑定，回落默认根", async () => {
    bindWorkspace("./workspace");
    const mod = await fresh();

    await expect(mod.resolveArtifactsDir()).resolves.toBe("/home/jean/.greyWork/artifacts");
    expect(h.invoke).toHaveBeenCalledWith("store_default_root");
  });

  it("默认根获取失败 → null，而不是拼出 'null/artifacts' 落盘", async () => {
    h.invoke.mockRejectedValue(new Error("host down"));
    const mod = await fresh();

    await expect(mod.resolveArtifactsDir()).resolves.toBeNull();
    expect(h.ensureDir).not.toHaveBeenCalled();
  });
});

describe("saveArtifactToDisk", () => {
  it("文本写入并返回磁盘路径", async () => {
    bindWorkspace(WORKSPACE_WORKSPACE_FOLDER);

    await expect(saveArtifactToDisk("报告.md", "# 报告")).resolves.toBe(`${WORKSPACE_WORKSPACE_FOLDER}/artifacts/报告.md`);
    expect(h.writeTextFile).toHaveBeenCalledWith(`${WORKSPACE_WORKSPACE_FOLDER}/artifacts/报告.md`, "# 报告");
  });

  it("二进制走 writeBinaryFile 通道", async () => {
    bindWorkspace(WORKSPACE_WORKSPACE_FOLDER);
    const bytes = new Uint8Array([1, 2, 3]);

    await expect(saveArtifactToDisk("pic.png", bytes)).resolves.toBe(`${WORKSPACE_WORKSPACE_FOLDER}/artifacts/pic.png`);
    expect(h.writeBinaryFile).toHaveBeenCalledWith(`${WORKSPACE_WORKSPACE_FOLDER}/artifacts/pic.png`, bytes);
    expect(h.writeTextFile).not.toHaveBeenCalled();
  });

  it("文件名净化：路径分隔与 C0 控制字符转 _，空名兜底 artifact", async () => {
    bindWorkspace(WORKSPACE_WORKSPACE_FOLDER);

    await saveArtifactToDisk("a/b\\c\u0001.csv", "x");
    expect(h.writeTextFile).toHaveBeenNthCalledWith(1, `${WORKSPACE_WORKSPACE_FOLDER}/artifacts/a_b_c_.csv`, "x");

    await saveArtifactToDisk("   ", "x");
    expect(h.writeTextFile).toHaveBeenNthCalledWith(2, `${WORKSPACE_WORKSPACE_FOLDER}/artifacts/artifact`, "x");
  });

  it("默认根结果被缓存：同会话内只问一次 host", async () => {
    const mod = await fresh();
    await mod.saveArtifactToDisk("a.md", "1");
    await mod.saveArtifactToDisk("b.md", "2");
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it("浏览器态返回 null，不建目录不写盘", async () => {
    h.isTauri.mockReturnValue(false);
    bindWorkspace(WORKSPACE_WORKSPACE_FOLDER);

    await expect(saveArtifactToDisk("a.md", "x")).resolves.toBeNull();
    expect(h.ensureDir).not.toHaveBeenCalled();
    expect(h.writeTextFile).not.toHaveBeenCalled();
  });

  it("写盘失败 → 返回 null 并 warn（不影响查看器内登记）", async () => {
    bindWorkspace(WORKSPACE_WORKSPACE_FOLDER);
    h.writeTextFile.mockRejectedValue(new Error("disk full"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(saveArtifactToDisk("a.md", "x")).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
  });

  it("目录创建失败 → 返回 null 且不碰写盘函数", async () => {
    bindWorkspace(WORKSPACE_WORKSPACE_FOLDER);
    h.ensureDir.mockRejectedValue(new Error("mkdir denied"));

    await expect(saveArtifactToDisk("a.md", "x")).resolves.toBeNull();
    expect(h.writeTextFile).not.toHaveBeenCalled();
  });
});
