// 技能设置 store：已安装扫描（frontmatter 解析）、市场搜索（宿主通道归一）、
// 安装/卸载（写盘命令参数与本地记录）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GreyWorkCore from "@greywork/core";
import { createPinia, setActivePinia } from "pinia";
import { parseSkillFrontmatter, resolveSkillsRoot, useSkillsStore } from "@/stores/skills";
import { effectScope } from "vue";
import { useCloudCatalog } from "@/features/cloud/useCloudCatalog";
import { useUserAccountStore } from "@/stores/user-account";

vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal()),
  invoke: vi.fn(),
}));
vi.mock("@greywork/core", async (importOriginal) => {
  const actual = await importOriginal<typeof GreyWorkCore>();
  return { ...actual, isTauriRuntime: () => true };
});
vi.mock("@/lib/workspace-dir", () => ({
  resolveWorkspaceRoot: () => Promise.resolve({ dir: "/ws/proj", bound: true }),
}));

const invokeMock = vi.mocked((await import("@greywork/host-ipc")).invoke);

const storageHolder = globalThis as { localStorage?: Storage };
const storage = new Map<string, string>();
storageHolder.localStorage = {
  get length() {
    return storage.size;
  },
  clear: () => storage.clear(),
  getItem: (key) => storage.get(key) ?? null,
  key: (index) => [...storage.keys()][index] ?? null,
  removeItem: (key) => void storage.delete(key),
  setItem: (key, value) => void storage.set(key, String(value)),
};

/** 按命令名分发假宿主：fs 扫描目录树 + skills 市场命令。 */
function host(marketResults: unknown[] = []): void {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    const path: string | undefined = (args as { path?: string } | undefined)?.path;
    switch (cmd) {
      case "fs_list_dir": {
        if (path === "/ws/proj/.agents/skills") {
          return [
            { name: "tdd", kind: "directory", path: "/ws/proj/.agents/skills/tdd" },
            { name: "notes", kind: "directory", path: "/ws/proj/.agents/skills/notes" },
          ];
        }
        return [];
      }
      case "fs_read_text_file": {
        if (path?.includes("/tdd/SKILL.md")) {
          return "---\nname: TDD\n---\nbody";
        }
        return "not a skill frontmatter";
      }
      case "skills_search":
        return marketResults;
      case "skills_download":
        return { files: [{ path: "SKILL.md", contents: "# x" }], hash: "snap-1" };
      case "skills_install":
        return { dir: "/ws/proj/.agents/skills/tdd", filesWritten: 1 };
      case "skills_uninstall":
        return null;
      case "skills_bundled_list":
        return [{ id: "ffmpeg-media", name: "ffmpeg 媒体处理", description: "转码 / 截取 / 抽帧", files: ["SKILL.md"] }];
      case "skills_install_bundled":
        return { dir: "/ws/proj/.agents/skills/ffmpeg-media", filesWritten: 1 };
      case "cloud_request":
        return (args as { path?: string })?.path?.startsWith("/api/download/")
          ? { files: [{ path: "SKILL.md", contents: "# cloud skill" }], hash: "cloud-snapshot" }
          : [];
      case "db_settings_load":
        return null;
      case "db_settings_sync":
        return null;
      default:
        throw new Error(`unexpected host command: ${cmd}`);
    }
  });
}

beforeEach(() => {
  // 桌面态 = 宿主托管：hasHostCommands() 为真（node 环境用 stubGlobal 提供最小 window）。
  vi.stubGlobal("window", { __GREYWORK_RUNTIME__: "server" });
  storage.clear();
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseSkillFrontmatter", () => {
  it("extracts single-line name/description, tolerating quotes and BOM", () => {
    const meta = parseSkillFrontmatter('\uFEFF---\nname: "Web Design"\ndescription: craft delightful UI\n---\nbody');
    expect(meta).toEqual({ name: "Web Design", description: "craft delightful UI" });
  });

  it("returns empty meta for content without frontmatter or malformed body", () => {
    expect(parseSkillFrontmatter("# plain markdown")).toEqual({});
    expect(parseSkillFrontmatter("---\nname: x")).toEqual({ name: "x" });
  });
});

describe("resolveSkillsRoot", () => {
  it("joins the resolved workspace root with .agents/skills", async () => {
    const ws = await resolveSkillsRoot();
    expect(ws).toEqual({ root: { dir: "/ws/proj", bound: true }, dir: "/ws/proj/.agents/skills" });
  });
});

describe("skills store 已安装", () => {
  it("scans the skills dir and parses each SKILL.md frontmatter", async () => {
    host();
    const store = useSkillsStore();
    expect(store.hostAvailable).toBe(true);

    await store.refreshInstalled();
    expect(store.installed.map((skill) => skill.id)).toEqual(["notes", "tdd"]);
    const tdd = store.installed.find((skill) => skill.id === "tdd");
    expect(tdd?.name).toBe("TDD");
    expect(tdd?.dir).toBe("/ws/proj/.agents/skills/tdd");
    // 无 frontmatter 的回落目录名
    expect(store.installed.find((skill) => skill.id === "notes")?.name).toBe("notes");
  });

  it("reports an empty list when the skills dir does not exist yet", async () => {
    invokeMock.mockRejectedValue(new Error("NotFound"));
    const store = useSkillsStore();
    await store.refreshInstalled();
    expect(store.installed).toEqual([]);
    expect(store.installedError).toBe("");
  });
});

describe("skills store 市场安装/卸载", () => {
  const MARKET_ITEM = {
    ref: "mattpocock/skills/tdd",
    skillId: "tdd",
    name: "TDD",
    installs: 10,
    source: "mattpocock/skills",
    downloadable: true,
  };

  it("searchDiscover normalizes host results and records errors", async () => {
    host([{ ref: "mattpocock/skills/tdd", skill_id: "tdd", name: "TDD", installs: 10, source: "mattpocock/skills", downloadable: true }]);
    const store = useSkillsStore();
    await store.searchDiscover("tdd");
    expect(invokeMock).toHaveBeenCalledWith("skills_search", { query: "tdd" });
    expect(store.discoverResults).toHaveLength(1);
    expect(store.discoverResults[0]).toMatchObject({ skillId: "tdd", ref: "mattpocock/skills/tdd" });

    await store.searchDiscover("");
    expect(store.discoverResults).toEqual([]);
  });

  it("installs through download + host write, records hash, and refreshes the list", async () => {
    host();
    const store = useSkillsStore();
    await store.installFromMarket(MARKET_ITEM);

    expect(invokeMock).toHaveBeenCalledWith("skills_download", { entryRef: "mattpocock/skills/tdd" });
    expect(invokeMock).toHaveBeenCalledWith("skills_install", {
      workspaceRoot: "/ws/proj",
      skillId: "tdd",
      files: [{ path: "SKILL.md", contents: "# x" }],
    });
    expect(store.recordBySkillId.get("tdd")).toMatchObject({ ref: "mattpocock/skills/tdd", hash: "snap-1" });
    expect(store.installed.find((skill) => skill.id === "tdd")).toBeTruthy();

    // 记录持久化：重载后仍在
    setActivePinia(createPinia());
    expect(useSkillsStore().recordBySkillId.get("tdd")?.hash).toBe("snap-1");
  });

  it("re-installing the same skillId overwrites the record instead of duplicating", async () => {
    host();
    const store = useSkillsStore();
    await store.installFromMarket(MARKET_ITEM);
    await store.installFromMarket(MARKET_ITEM);
    expect(store.records).toHaveLength(1);
  });

  it("uninstalls via host command and drops the local record", async () => {
    host();
    const store = useSkillsStore();
    await store.installFromMarket(MARKET_ITEM);
    await store.uninstallSkill("tdd");

    expect(invokeMock).toHaveBeenCalledWith("skills_uninstall", { workspaceRoot: "/ws/proj", skillId: "tdd" });
    expect(store.recordBySkillId.has("tdd")).toBe(false);
    expect(store.installed.find((skill) => skill.id === "tdd")).toBeUndefined();
  });
});

describe("skills store 内置技能", () => {
  it("refreshBundled lists host-provided skills and exposes bundledIds", async () => {
    host();
    const store = useSkillsStore();
    await store.refreshBundled();

    expect(invokeMock).toHaveBeenCalledWith("skills_bundled_list");
    expect(store.bundled.map((skill) => skill.id)).toEqual(["ffmpeg-media"]);
    expect(store.bundledIds.has("ffmpeg-media")).toBe(true);
    expect(store.bundledError).toBe("");
  });

  it("refreshBundled clears the list and records the error when the host fails", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    const store = useSkillsStore();
    await store.refreshBundled();
    expect(store.bundled).toEqual([]);
    expect(store.bundledError).toContain("boom");
  });

  it("installBundled writes via host, then refreshes the installed scan", async () => {
    host();
    const store = useSkillsStore();
    await store.installBundled("ffmpeg-media");

    expect(invokeMock).toHaveBeenCalledWith("skills_install_bundled", {
      workspaceRoot: "/ws/proj",
      skillId: "ffmpeg-media",
    });
    // 装完刷新了磁盘扫描，busyId 归零
    expect(store.installed.map((skill) => skill.id)).toContain("tdd");
    expect(store.busyId).toBeNull();
  });

  it("installBundled surfaces host rejection and still clears busyId", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "skills_install_bundled") throw new Error("不是内置技能: nope");
      if (cmd === "fs_list_dir") return [];
      throw new Error(`unexpected host command: ${cmd}`);
    });
    const store = useSkillsStore();
    await expect(store.installBundled("nope")).rejects.toThrow("不是内置技能");
    expect(store.busyId).toBeNull();
  });
});

describe("云端技能安装记录", () => {
  const entry = {
    ref: "greywork/skills/tdd",
    skillId: "tdd",
    name: "Cloud TDD",
    installs: 0,
    source: "greywork",
    downloadable: true,
    origin: "https://cloud.test",
  };
  function catalog() {
    useUserAccountStore().session = {
      user: { id: "1", email: "test@example.local", displayName: null, role: "user" },
      device: { id: "2", name: "test", platform: "desktop" },
    };
    const scope = effectScope();
    return { scope, catalog: scope.run(() => useCloudCatalog())! };
  }
  it("首次云端安装维护记录，重载后更新仍使用原云端来源", async () => {
    host();
    const store = useSkillsStore();
    const mounted = catalog();
    try {
      await mounted.catalog.install(entry);
      expect(store.recordBySkillId.get("tdd")).toMatchObject({ ref: entry.ref, hash: "cloud-snapshot", origin: entry.origin });
      setActivePinia(createPinia());
      const restored = useSkillsStore();
      expect(restored.recordBySkillId.get("tdd")).toMatchObject({ ref: entry.ref, origin: entry.origin });
      await restored.updateInstalled("tdd");
      expect(invokeMock).toHaveBeenCalledWith("skills_download", { entryRef: entry.ref, origin: entry.origin });
    } finally {
      mounted.scope.stop();
    }
  });
  it("云端覆盖同名技能时替换旧市场记录", async () => {
    host();
    const store = useSkillsStore();
    await store.installFromMarket({ ...entry, ref: "old/source/tdd", origin: undefined });
    const mounted = catalog();
    try {
      await mounted.catalog.install(entry);
      expect(store.records).toHaveLength(1);
      expect(store.records[0]).toMatchObject({ ref: entry.ref, hash: "cloud-snapshot", origin: entry.origin });
    } finally {
      mounted.scope.stop();
    }
  });
  it("安装失败不替换原记录，并释放共享 busy 状态", async () => {
    host();
    const store = useSkillsStore();
    await store.installFromMarket({ ...entry, ref: "old/source/tdd", origin: undefined });
    const respond = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "skills_install") throw new Error("write failed");
      return respond(command, args);
    });
    const mounted = catalog();
    try {
      await mounted.catalog.install(entry);
      expect(mounted.catalog.error.value).toContain("write failed");
      expect(store.recordBySkillId.get("tdd")?.ref).toBe("old/source/tdd");
      expect(store.busyId).toBeNull();
    } finally {
      mounted.scope.stop();
    }
  });
  it("云端安装与设置页安装/卸载共用 busy 锁", async () => {
    host();
    const store = useSkillsStore();
    const mounted = catalog();
    let started!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const respond = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "skills_install") {
        started();
        await pending;
      }
      return respond(command, args);
    });
    const installing = mounted.catalog.install(entry);
    await entered;
    try {
      expect(store.busyId).toBe("tdd");
      await expect(store.uninstallSkill("notes")).rejects.toThrow("正在进行");
      await expect(store.installFromMarket({ ...entry, skillId: "notes" })).rejects.toThrow("正在进行");
      await expect(store.installBundled("ffmpeg-media")).rejects.toThrow("正在进行");
      expect(invokeMock).not.toHaveBeenCalledWith("skills_uninstall", expect.anything());
    } finally {
      finish();
      await installing;
      mounted.scope.stop();
    }
    expect(store.busyId).toBeNull();
  });
  it("复用安装入口后仍按当前工作区落盘，不沿用设置页的旧缓存", async () => {
    host();
    const store = useSkillsStore();
    await store.refreshInstalled();
    const root = vi
      .spyOn(await import("@/lib/workspace-dir"), "resolveWorkspaceRoot")
      .mockResolvedValue({ dir: "/ws/current", bound: true });
    const mounted = catalog();
    try {
      await mounted.catalog.install(entry);
      expect(invokeMock).toHaveBeenCalledWith("skills_install", {
        workspaceRoot: "/ws/current",
        skillId: "tdd",
        files: [{ path: "SKILL.md", contents: "# cloud skill" }],
      });
    } finally {
      root.mockRestore();
      mounted.scope.stop();
    }
  });
});
