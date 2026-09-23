// 工作区存储契约：种子 / CRUD / 文件登记去重 / 旧版项目数据迁移 / 持久化往返。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useWorkspaceStore } from "@/stores/workspace";

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
  it("无持久化数据时从空工作区清单开始（首启不伪造工作区）", () => {
    const store = useWorkspaceStore();
    expect(store.workspaces).toHaveLength(0);
    expect(store.activeWorkspaceId).toBeNull();
  });

  it("createWorkspace 追加并置为当前", () => {
    const store = useWorkspaceStore();
    const workspace = store.createWorkspace("  新工作区  ", "描述");
    expect(workspace.name).toBe("新工作区");
    expect(store.activeWorkspaceId).toBe(workspace.id);
    expect(store.workspaces).toHaveLength(1);
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
    expect(store.activeWorkspaceId).toBeNull();
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

  it("ensureWorkspace 按固定 id 幂等创建且不切换当前工作区", () => {
    const store = useWorkspaceStore();
    const current = store.createWorkspace("当前工作区");
    const remote = store.ensureWorkspace({ id: "w-remote", name: "远程助手", icon: "robot" });
    expect(remote.id).toBe("w-remote");
    expect(remote.icon).toBe("robot");
    expect(store.activeWorkspaceId).toBe(current.id);
    expect(store.ensureWorkspace({ id: "w-remote", name: "别的名字" }).id).toBe(remote.id);
    expect(store.workspaces.filter((workspace) => workspace.id === "w-remote")).toHaveLength(1);
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

describe("最近使用 / 默认工作区 / agent 配置记忆", () => {
  it("v1 存储迁移到 v2：lastUsedAt 取 updatedAt，默认工作区为空", () => {
    injectStorage();
    try {
      storageHolder.localStorage?.setItem(
        "greywork.workspaces",
        JSON.stringify({
          version: 1,
          workspaces: [{ id: "w-1", name: "老工作区", description: "", files: [], createdAt: 1, updatedAt: 4200 }],
          activeWorkspaceId: "w-1",
        }),
      );
      const store = useWorkspaceStore();
      expect(store.workspaceById("w-1")?.lastUsedAt).toBe(4200);
      expect(store.defaultWorkspaceId).toBeNull();
    } finally {
      delete storageHolder.localStorage;
    }
  });

  it("recentWorkspaces 按最近使用倒序；切换即刷新使用时刻", () => {
    injectStorage();
    // Date.now() 毫秒分辨率下同帧创建/切换会撞成同一时刻，用假时钟把顺序钉死
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      const store = useWorkspaceStore();
      const first = store.createWorkspace("先建");
      vi.advanceTimersByTime(10);
      const second = store.createWorkspace("后建");
      vi.advanceTimersByTime(10);
      store.setActiveWorkspace(first.id);
      expect(store.recentWorkspaces[0]?.id).toBe(first.id);
      vi.advanceTimersByTime(10);
      store.setActiveWorkspace(second.id);
      expect(store.recentWorkspaces[0]?.id).toBe(second.id);
    } finally {
      vi.useRealTimers();
      delete storageHolder.localStorage;
    }
  });

  it("默认工作区持久化：无上次激活记录时作为启动落点", () => {
    injectStorage();
    try {
      const store = useWorkspaceStore();
      const workspace = store.createWorkspace("默认项目");
      store.setDefaultWorkspace(workspace.id);
      // 清掉「上次激活」，只留默认项
      const raw = JSON.parse(storageHolder.localStorage?.getItem("greywork.workspaces") ?? "{}");
      raw.activeWorkspaceId = null;
      storageHolder.localStorage?.setItem("greywork.workspaces", JSON.stringify(raw));

      setActivePinia(createPinia());
      const reloaded = useWorkspaceStore();
      expect(reloaded.defaultWorkspaceId).toBe(workspace.id);
      expect(reloaded.activeWorkspaceId).toBe(workspace.id);
    } finally {
      delete storageHolder.localStorage;
    }
  });

  it("删除默认工作区后默认项归空", () => {
    injectStorage();
    try {
      const store = useWorkspaceStore();
      const workspace = store.createWorkspace("待删");
      store.setDefaultWorkspace(workspace.id);
      store.deleteWorkspace(workspace.id);
      expect(store.defaultWorkspaceId).toBeNull();
    } finally {
      delete storageHolder.localStorage;
    }
  });

  it("setAgentConfig：providerId 覆盖，configValues 逐键浅合并且往返持久化", () => {
    injectStorage();
    try {
      const store = useWorkspaceStore();
      const workspace = store.createWorkspace("配置记忆");
      store.setAgentConfig(workspace.id, { providerId: "opencode", configValues: { model: "gpt-5-codex" } });
      store.setAgentConfig(workspace.id, { configValues: { effort: "high" } });

      const remembered = store.agentConfigOf(workspace.id);
      expect(remembered?.providerId).toBe("opencode");
      expect(remembered?.configValues).toEqual({ model: "gpt-5-codex", effort: "high" });

      store.setAgentConfig(workspace.id, { providerId: null });
      expect(store.agentConfigOf(workspace.id)?.providerId).toBeNull();
      expect(store.agentConfigOf(workspace.id)?.configValues).toEqual({ model: "gpt-5-codex", effort: "high" });

      setActivePinia(createPinia());
      expect(useWorkspaceStore().agentConfigOf(workspace.id)?.configValues?.effort).toBe("high");
    } finally {
      delete storageHolder.localStorage;
    }
  });

  it("未记录过配置的工作区返回 undefined（调用方据此不动当前状态）", () => {
    const store = useWorkspaceStore();
    expect(store.agentConfigOf(store.workspaces[0]?.id ?? null)).toBeUndefined();
    expect(store.agentConfigOf(null)).toBeUndefined();
  });
});
