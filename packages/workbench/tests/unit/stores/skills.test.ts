// 技能设置 store：已安装扫描（frontmatter 解析）、市场搜索（宿主通道归一）、
// 安装/卸载（写盘命令参数与本地记录）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GreyWorkCore from "@greywork/core";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { parseSkillFrontmatter, resolveSkillsRoot, useSkillsStore } from "@/stores/skills";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@greywork/core", async (importOriginal) => {
  const actual = await importOriginal<typeof GreyWorkCore>();
  return { ...actual, isTauriRuntime: () => true };
});
vi.mock("@/lib/workspace-dir", () => ({
  resolveWorkspaceRoot: () => Promise.resolve({ dir: "/ws/proj", bound: true }),
}));

const invokeMock = vi.mocked(invoke);

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
      default:
        throw new Error(`unexpected host command: ${cmd}`);
    }
  });
}

beforeEach(() => {
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
