// 工作区存储契约：种子 / CRUD / 文件登记去重 / 旧版项目数据迁移 / 持久化往返。
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useWorkspaceStore } from "./workspace";

const storageHolder = globalThis as { localStorage?: Storage };

function injectStorage(): void {
  const backing: Record<string, string> = {};
  storageHolder.localStorage = {
    getItem: (key: string) => backing[key] ?? null,
    setItem: (key: string, value: string) => {
      backing[key] = value;
    },
    removeItem: (key: string) => {
      delete backing[key];
    },
    clear: () => {
      for (const key of Object.keys(backing)) delete backing[key];
    },
    key: (index: number) => Object.keys(backing)[index] ?? null,
    get length() {
      return Object.keys(backing).length;
    },
  } as Storage;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("工作区 CRUD", () => {
  it("无持久化数据时按 mock 工作区清单初始化", () => {
    const store = useWorkspaceStore();
    expect(store.workspaces.length).toBe(3);
    expect(store.workspaceById("p-gw-main")?.name).toBe("GreyWork 主仓");
    expect(store.activeWorkspaceId).toBe("p-gw-main");
  });

  it("createWorkspace 追加并置为当前", () => {
    const store = useWorkspaceStore();
    const workspace = store.createWorkspace("  新工作区  ", "描述");
    expect(workspace.name).toBe("新工作区");
    expect(store.activeWorkspaceId).toBe(workspace.id);
    expect(store.workspaces).toHaveLength(4);
  });

  it("renameWorkspace 校验空名；deleteWorkspace 移除并回退激活项", () => {
    const store = useWorkspaceStore();
    const workspace = store.createWorkspace("待改");
    store.renameWorkspace(workspace.id, "改后");
    expect(store.workspaceById(workspace.id)?.name).toBe("改后");
    store.renameWorkspace(workspace.id, "  ");
    expect(store.workspaceById(workspace.id)?.name).toBe("改后");

    store.deleteWorkspace(workspace.id);
    expect(store.workspaceById(workspace.id)).toBeUndefined();
    expect(store.activeWorkspaceId).toBe("p-gw-main");
  });

  it("addFile 同 vfsPath 去重；removeFile 移除", () => {
    const store = useWorkspaceStore();
    const workspace = store.createWorkspace("文件工作区");
    store.addFile(workspace.id, { name: "a.ts", vfsPath: "workspaces/x/a.ts", kind: "file" });
    store.addFile(workspace.id, { name: "a.ts", vfsPath: "workspaces/x/a.ts", kind: "file", size: 42 });
    expect(store.workspaceById(workspace.id)?.files).toHaveLength(1);
    expect(store.workspaceById(workspace.id)?.files[0]?.size).toBe(42);

    store.removeFile(workspace.id, "workspaces/x/a.ts");
    expect(store.workspaceById(workspace.id)?.files).toHaveLength(0);
  });

  it("setFolder 记录存放文件夹", () => {
    const store = useWorkspaceStore();
    const workspace = store.createWorkspace("文件夹工作区");
    store.setFolder(workspace.id, "/home/user/work/files");
    expect(store.workspaceById(workspace.id)?.folder).toBe("/home/user/work/files");
  });
});

describe("迁移与持久化", () => {
  it("旧版 greywork.projects 数据迁移为工作区（root → folder）", () => {
    injectStorage();
    try {
      storageHolder.localStorage?.setItem(
        "greywork.projects",
        JSON.stringify({
          version: 1,
          projects: [{ id: "p-old", name: "旧项目", description: "旧描述", root: "/old/root", files: [], createdAt: 1, updatedAt: 2 }],
          activeProjectId: "p-old",
        }),
      );
      const store = useWorkspaceStore();
      const migrated = store.workspaceById("p-old");
      expect(migrated?.name).toBe("旧项目");
      expect(migrated?.folder).toBe("/old/root");
      expect(store.activeWorkspaceId).toBe("p-old");
    } finally {
      delete storageHolder.localStorage;
    }
  });

  it("写操作落盘，重新加载后状态还原", () => {
    injectStorage();
    try {
      const store = useWorkspaceStore();
      const workspace = store.createWorkspace("持久工作区", "说明");
      store.setFolder(workspace.id, "/data");
      store.addFile(workspace.id, { name: "r.md", vfsPath: "workspaces/p/r.md", kind: "file" });

      setActivePinia(createPinia());
      const reloaded = useWorkspaceStore();
      const restored = reloaded.workspaceById(workspace.id);
      expect(restored?.name).toBe("持久工作区");
      expect(restored?.folder).toBe("/data");
      expect(restored?.files[0]?.vfsPath).toBe("workspaces/p/r.md");
      expect(reloaded.activeWorkspaceId).toBe(workspace.id);
    } finally {
      delete storageHolder.localStorage;
    }
  });
});
