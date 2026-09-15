/**
 * 内存 git 的状态/差异分支 + 文件系统剩余分支的补测。
 *
 * 分工说明（与 memory.test.ts、workbench/tests/unit/stores/vfs.test.ts 三方分界）：
 * - memory.test.ts：二进制/文本互斥、list 元数据、差集语义、diff 封顶、commit 基线；
 * - workbench vfs.test.ts：读写/列目录/增删改主干、untracked 与单路径 diff；
 * - 本文件：主干没盖到的 status() 的 modified/deleted 分支、无参 diff() 的多文件
 *   汇总头、删除文件后的 diff 形态、以及 fs 的 exists(false) / 空列表 / rename 覆盖。
 *
 * 别把主干用例搬来——重复的用例改一处要改两处，久了必然漂移。
 */
import { describe, expect, it } from "vitest";
import { createMemoryFileSystem, createMemoryGitService } from "../../src/memory";

describe("内存 git · status() 的三态与排序", () => {
  it("modified / untracked / deleted 并存，且按路径排好序", async () => {
    const fs = createMemoryFileSystem({ "a.ts": "x", "z.txt": "keep" });
    const git = createMemoryGitService(fs);

    await fs.writeFile("a.ts", "y"); // 改
    await fs.writeFile("b/c.ts", "new"); // 增
    await fs.delete("z.txt"); // 删

    expect(await git.status()).toEqual([
      { path: "a.ts", status: "modified" },
      { path: "b/c.ts", status: "untracked" },
      { path: "z.txt", status: "deleted" },
    ]);
  });
});

describe("内存 git · 无参 diff() 的多文件模式", () => {
  it("多文件变更合并成一块 patch，尾部汇总头用的是未截断统计", async () => {
    const fs = createMemoryFileSystem({ "a.ts": "old", "b/stale.md": "# old" });
    const git = createMemoryGitService(fs);

    await fs.writeFile("a.ts", "new");
    await fs.writeFile("b/stale.md", "# re");

    const patch = await git.diff();
    expect(patch).toContain("--- a/a.ts");
    expect(patch).toContain("--- a/b/stale.md");
    // 两侧都非空，不引入空串噪音——每文件恰好 1 增 1 删
    expect(patch).toContain("（2 增 / 2 删）");
    // 块与块之间用空行隔开
    expect(patch).toContain("\n\n--- a/b/stale.md");
  });

  it("删除文件也按行差集出块：删掉的每一行都有 - 前缀", async () => {
    const fs = createMemoryFileSystem({ "gone.txt": "x\ny" });
    const git = createMemoryGitService(fs);
    await fs.delete("gone.txt");

    const patch = await git.diff("gone.txt");
    expect(patch).toContain("--- a/gone.txt");
    expect(patch).toContain("- x");
    expect(patch).toContain("- y");
    // 当前面为空串时，split 会把空串算成一个「新增行」——差集统计里的固有噪音，
    // 与 memory.test.ts 里「两侧都非空就不会有噪音」的注释是同一件事。
    expect(patch).toContain("（1 增 / 2 删）");
  });

  it("只对变化的文件出块：没动过的文件不产生 patch", async () => {
    const fs = createMemoryFileSystem({ "stable.ts": "same" });
    const git = createMemoryGitService(fs);
    await fs.writeFile("stable.ts", "same"); // 内容没变
    await fs.writeFile("new.md", "# hi");

    const patch = await git.diff();
    expect(patch).toContain("--- a/new.md");
    expect(patch).not.toContain("stable.ts");
  });
});

describe("内存 git · 空白基线的快照关系", () => {
  it("空文件系统上 diff() 返回无变更，commit 后基线为空", async () => {
    const fs = createMemoryFileSystem();
    const git = createMemoryGitService(fs);
    expect(await git.diff()).toBe("无变更。");
    const result = await git.commit("chore: empty");
    expect(result.hash).toMatch(/^a1f0{10}1$/);
    expect(await git.status()).toEqual([]);
  });
});

describe("内存文件系统 · 剩余分支", () => {
  it("空文件系统 list() 返回空数组，exists 对不存在路径返回 false", async () => {
    const fs = createMemoryFileSystem();
    expect(await fs.list()).toEqual([]);
    expect(await fs.list("src")).toEqual([]);
    await expect(fs.exists("ghost.txt")).resolves.toBe(false);
  });

  it("rename 文本文件时目标已存在则直接覆盖（文档里写的覆盖语义）", async () => {
    const fs = createMemoryFileSystem({ "a.ts": "winner", "b.ts": "loser" });
    await fs.rename("a.ts", "b.ts");
    await expect(fs.readFile("b.ts")).resolves.toBe("winner");
    await expect(fs.exists("a.ts")).resolves.toBe(false);
  });
});
