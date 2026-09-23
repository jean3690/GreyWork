import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as GreyWorkCore from "@greywork/core";

const h = vi.hoisted(() => ({
  tauri: false,
  ensureDir: vi.fn(),
  resolveWorkspaceDir: vi.fn(),
}));

vi.mock("@greywork/core", async (importOriginal) => ({
  ...(await importOriginal<typeof GreyWorkCore>()),
  isTauriRuntime: () => h.tauri,
  joinPath: (root: string, child: string) => `${root}/${child}`,
}));
vi.mock("@/state/workspaceFiles", () => ({ ensureDir: (...args: unknown[]) => h.ensureDir(...args) }));
vi.mock("@/lib/workspace-dir", () => ({ resolveWorkspaceDir: () => h.resolveWorkspaceDir() }));

import { ensureRemoteWorkspace, ensureRemoteWorkspaceFolder, REMOTE_WORKSPACE_ID } from "@/lib/remote-workspace";

function store() {
  const records = new Map<
    string,
    {
      id: string;
      name: string;
      description: string;
      files: never[];
      createdAt: number;
      updatedAt: number;
      lastUsedAt: number;
      icon?: string;
      folder?: string;
    }
  >();
  const active = "normal";
  return {
    records,
    get active() {
      return active;
    },
    workspaceById: (id: string | null) => (id ? records.get(id) : undefined),
    ensureWorkspace: (seed: { id: string; name: string; description?: string; icon?: string }) => {
      const record = {
        id: seed.id,
        name: seed.name,
        description: seed.description ?? "",
        files: [],
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
        icon: seed.icon,
      } as never;
      records.set(seed.id, record);
      return record;
    },
    setFolder: (id: string, folder: string) => {
      const record = records.get(id);
      if (record) record.folder = folder;
    },
  };
}

beforeEach(() => {
  h.tauri = false;
  h.ensureDir.mockReset();
  h.resolveWorkspaceDir.mockReset();
  h.resolveWorkspaceDir.mockResolvedValue("/home/test/.greyWork");
});

describe("ensureRemoteWorkspace", () => {
  it("按固定 id 幂等创建，且不改当前激活工作区", () => {
    const target = store();
    const first = ensureRemoteWorkspace(target);
    const second = ensureRemoteWorkspace(target);
    expect(first).toBe(second);
    expect(first.id).toBe(REMOTE_WORKSPACE_ID);
    expect(first.icon).toBe("robot");
    expect(target.active).toBe("normal");
  });
});

describe("ensureRemoteWorkspaceFolder", () => {
  it("非桌面端不创建文件夹", async () => {
    const target = store();
    await expect(ensureRemoteWorkspaceFolder(target)).resolves.toBeNull();
    expect(target.records.size).toBe(0);
    expect(h.ensureDir).not.toHaveBeenCalled();
  });

  it("桌面端首次绑定默认 remote 文件夹", async () => {
    h.tauri = true;
    const target = store();
    await expect(ensureRemoteWorkspaceFolder(target)).resolves.toBe("/home/test/.greyWork/remote");
    expect(h.ensureDir).toHaveBeenCalledWith("/home/test/.greyWork/remote");
    expect(target.records.get(REMOTE_WORKSPACE_ID)?.folder).toBe("/home/test/.greyWork/remote");
  });

  it("已有绑定时不重复创建", async () => {
    h.tauri = true;
    const target = store();
    const record = ensureRemoteWorkspace(target);
    record.folder = "/custom/remote";
    await expect(ensureRemoteWorkspaceFolder(target)).resolves.toBe("/custom/remote");
    expect(h.ensureDir).not.toHaveBeenCalled();
  });
});
