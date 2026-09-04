import { createMemoryFileSystem, createMemoryGitService } from "@greywork/editor";
import { describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { buildFileTree, statusLetter, useVfsStore, WORKSPACE_SEED, workspaceFs, workspaceGit } from "@/stores/vfs";

describe("memory file system", () => {
  it("reads and writes seeded files", async () => {
    const fs = createMemoryFileSystem({ "a/b.ts": "export {};\n" });
    await expect(fs.readFile("a/b.ts")).resolves.toBe("export {};\n");
    await expect(fs.readFile("missing.ts")).rejects.toThrow("File not found");
    await fs.writeFile("a/c.md", "# hi\n");
    await expect(fs.exists("a/c.md")).resolves.toBe(true);
  });

  it("lists directories with virtual directory nodes", async () => {
    const fs = createMemoryFileSystem({ "src/a.ts": "1", "src/deep/b.ts": "2", "readme.md": "3" });
    const root = await fs.list();
    expect(root.map((entry) => `${entry.path}:${entry.kind}`)).toEqual(["readme.md:file", "src:directory"]);
    const src = await fs.list("src");
    expect(src.map((entry) => entry.path).sort()).toEqual(["src/a.ts", "src/deep"]);
    expect((await fs.readFile("src/deep/b.ts")).length).toBeGreaterThan(0);
  });

  it("deletes and renames with not-found errors", async () => {
    const fs = createMemoryFileSystem({ "old.ts": "x" });
    await fs.rename("old.ts", "new.ts");
    await expect(fs.exists("old.ts")).resolves.toBe(false);
    await expect(fs.readFile("new.ts")).resolves.toBe("x");
    await expect(fs.rename("ghost.ts", "any.ts")).rejects.toThrow("File not found");
    await fs.delete("new.ts");
    await expect(fs.exists("new.ts")).resolves.toBe(false);
    await expect(fs.delete("new.ts")).rejects.toThrow("File not found");
    expect(Object.keys(fs.snapshot())).toEqual([]);
  });

  it("writes binary files isolated from snapshot, listable with byte size", async () => {
    const fs = createMemoryFileSystem({ "readme.md": "hi" });
    await fs.writeBinary("reports/a.xlsx", new Uint8Array([0, 1, 2, 3, 4]));
    expect(await fs.exists("reports/a.xlsx")).toBe(true);
    expect(await fs.readBinary("reports/a.xlsx")).toEqual(new Uint8Array([0, 1, 2, 3, 4]));
    await expect(fs.readFile("reports/a.xlsx")).rejects.toThrow("File not found");
    // 二进制不进入文本快照（git/diff 基线）
    expect(Object.keys(fs.snapshot())).toEqual(["readme.md"]);
    const report = await fs.list("reports");
    expect(report[0]?.size).toBe(5);
    // 二进制文件不干扰 git status（不进基线也不产生变更）
    const git = createMemoryGitService(fs);
    expect(await git.status()).toEqual([]);
  });
});

describe("memory git on vfs", () => {
  it("reports clean status on the seed baseline", async () => {
    const fs = createMemoryFileSystem({ "seed.ts": "const a = 1;\n" });
    const git = createMemoryGitService(fs);
    await expect(git.changes()).resolves.toEqual([]);
    await expect(git.diff()).resolves.toBe("无变更。");
    await expect(git.currentBranch()).resolves.toBe("feature/plugin-market");
    await expect(git.branches()).resolves.toContain("main");
  });

  it("tracks add, modify and delete with line stats until commit", async () => {
    const fs = createMemoryFileSystem({ "keep.ts": "a\nb\nc\n", "gone.txt": "x\n" });
    const git = createMemoryGitService(fs);
    await fs.writeFile("keep.ts", "a\nB\nc\nd\n");
    await fs.writeFile("new.md", "# title\nbody\n");

    let changes = await git.changes();
    const byPath = new Map(changes.map((change) => [change.path, change]));
    expect(byPath.get("keep.ts")).toMatchObject({ status: "modified", add: 2, del: 1 });
    expect(byPath.get("new.md")).toMatchObject({ status: "untracked", add: 2, del: 0 });
    expect(byPath.get("gone.txt")?.status).toBeUndefined();

    await fs.delete("gone.txt");
    changes = await git.changes();
    expect(changes.find((change) => change.path === "gone.txt")).toMatchObject({ status: "deleted", add: 0, del: 1 });

    const diff = await git.diff("new.md");
    expect(diff).toContain("--- a/new.md");
    expect(diff).toContain("+ # title");

    const commit = await git.commit("chore: baseline");
    expect(commit.hash).toMatch(/^a1f0{10}1$/);
    await expect(git.status()).resolves.toEqual([]);
  });
});

describe("vfs store", () => {
  it("exposes the shared workspace with a clean baseline", () => {
    expect(Object.keys(workspaceFs.snapshot()).sort()).toEqual(Object.keys(WORKSPACE_SEED).sort());
    expect(workspaceGit).toBeTruthy();
  });

  it("opens, edits and saves through the store", async () => {
    setActivePinia(createPinia());
    const vfs = useVfsStore();
    await vfs.open("src/plugins/index.ts");
    expect(vfs.activeContent).toBe(WORKSPACE_SEED["src/plugins/index.ts"]);
    expect(vfs.dirty).toBe(false);

    vfs.activeContent = `${vfs.activeContent}\n// edited\n`;
    expect(vfs.dirty).toBe(true);
    await vfs.saveActive();
    expect(vfs.dirty).toBe(false);
    await expect(workspaceFs.readFile("src/plugins/index.ts")).resolves.toContain("// edited");
    expect(vfs.changes.some((change) => change.path === "src/plugins/index.ts" && change.status === "modified")).toBe(true);
  });

  it("writes pipeline files and refreshes changes", async () => {
    setActivePinia(createPinia());
    const vfs = useVfsStore();
    const path = `reports/generated-${Date.now()}.md`;
    await vfs.write(path, "# 生成物");
    expect(vfs.paths).toContain(path);
    const change = vfs.changes.find((entry) => entry.path === path);
    expect(change).toMatchObject({ status: "untracked", add: 1, del: 0 });
    await workspaceGit.commit("test: consume");
    await vfs.refreshStatus();
    expect(vfs.changes.find((entry) => entry.path === path)).toBeUndefined();
  });
});

describe("buildFileTree", () => {
  it("builds nested directories first with sorted names", () => {
    const tree = buildFileTree(["b.ts", "src/deep/x.ts", "src/a.ts", "reports/r.md"]);
    expect(tree.map((node) => node.name)).toEqual(["reports", "src", "b.ts"]);
    const src = tree.find((node) => node.name === "src");
    expect(src?.children?.map((node) => `${node.name}:${node.kind}`)).toEqual(["deep:directory", "a.ts:file"]);
    expect(src?.children?.find((node) => node.name === "deep")?.children?.[0]).toMatchObject({ path: "src/deep/x.ts", kind: "file" });
  });

  it("merges shared directory prefixes and keeps paths distinct", () => {
    const tree = buildFileTree(["data/stations.csv", "data/other.csv"]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ name: "data", kind: "directory" });
    expect(tree[0].children?.map((node) => node.path)).toEqual(["data/other.csv", "data/stations.csv"]);
  });

  it("treats a bare path as a file distinct from a same-named directory", () => {
    const tree = buildFileTree(["data", "data/stations.csv"]);
    expect(tree.map((node) => `${node.name}:${node.kind}`)).toEqual(["data:directory", "data:file"]);
  });
});

describe("status letters", () => {
  it("maps statuses to letters", () => {
    expect(statusLetter("modified")).toBe("M");
    expect(statusLetter("untracked")).toBe("U");
    expect(statusLetter("deleted")).toBe("D");
  });
});
