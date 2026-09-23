/**
 * 内存文件系统与内存 git 的单测。
 *
 * 注意与 `packages/workbench/tests/unit/stores/vfs.test.ts` 的分工：那份测的是 workbench
 * 的 vfs store，顺带过了内存实现的主干（读写/列目录/增删改/commit）。这里只补主干没盖到的
 * 分支，别重复——重复的用例改一处要改两处，久了必然漂移。
 *
 * 补的是这几处：二进制与文本互斥、二进制 rename 的早返回分支、list 的 language/size、
 * 多重集行差集对重复行的处理、diff 正文 200 行封顶而统计不封顶、commit 次数与基线重置。
 */
import { describe, expect, it } from "vitest";
import { createMemoryFileSystem, createMemoryGitService } from "../../src/memory";

describe("内存文件系统 · 二进制与文本的关系", () => {
  it("写二进制会清掉同路径的文本：两张表互斥，不会同时存在两个版本", async () => {
    const fs = createMemoryFileSystem();
    await fs.writeFile("book.xlsx", "先当成文本写进去的");
    await fs.writeBinary("book.xlsx", new Uint8Array([1, 2, 3]));
    await expect(fs.readFile("book.xlsx")).rejects.toThrow("File not found: book.xlsx");
    await expect(fs.readBinary("book.xlsx")).resolves.toEqual(new Uint8Array([1, 2, 3]));
    // 文本表已被清空，所以快照（git 基线）里也不该再有它
    expect(fs.snapshot()).toEqual({});
  });

  it("对文本路径读二进制要报错，而不是把字符串当字节返回", async () => {
    const fs = createMemoryFileSystem({ "a.ts": "x" });
    await expect(fs.readBinary("a.ts")).rejects.toThrow("Binary file not found: a.ts");
  });

  it("rename 二进制走的是另一条分支（早返回，不碰文本表）", async () => {
    const fs = createMemoryFileSystem();
    await fs.writeBinary("old.png", new Uint8Array([7, 8]));
    await fs.rename("old.png", "new.png");
    await expect(fs.exists("old.png")).resolves.toBe(false);
    await expect(fs.readBinary("new.png")).resolves.toEqual(new Uint8Array([7, 8]));
    expect(fs.snapshot()).toEqual({});
  });
});

describe("内存文件系统 · list 的元数据", () => {
  it("文本文件的 language 取扩展名、size 取字符数", async () => {
    const fs = createMemoryFileSystem({ "src/index.ts": "export {}" });
    const entries = await fs.list("src");
    const file = entries.find((entry) => entry.path === "src/index.ts");
    expect(file).toMatchObject({ kind: "file", language: "ts", size: "export {}".length });
  });

  it("目录节点的 size 是 undefined —— 没有「目录多大」这回事", async () => {
    const fs = createMemoryFileSystem({ "src/index.ts": "x" });
    const [dir] = await fs.list();
    expect(dir).toMatchObject({ path: "src", kind: "directory" });
    expect(dir?.size).toBeUndefined();
  });
});

describe("内存 git · 行差集是多重集语义", () => {
  it("重复行按重数计：删掉一个重复的 x 要算一次删除", async () => {
    // 集合语义的实现会认为「x 还在」，报 0 删 —— 那对「这个文件到底改了没有」是误导。
    const fs = createMemoryFileSystem({ "a.ts": "x\nx\ny" });
    const git = createMemoryGitService(fs);
    await fs.writeFile("a.ts", "x\ny\nz");
    const change = (await git.changes()).find((entry) => entry.path === "a.ts");
    expect(change).toMatchObject({ worktree: "modified", add: 1, del: 1 });
  });

  it("只看重数不看顺序：行序调换被多重集语义吞掉（这是已知限制，不是期望行为）", async () => {
    const fs = createMemoryFileSystem({ "a.ts": "a\nb" });
    const git = createMemoryGitService(fs);
    await fs.writeFile("a.ts", "b\na");
    // 内容确实换了顺序，但重数相等 —— 文件仍被判为 modified（原始字符串不同），
    // 行统计却是 0 增 0 删，于是 diff 输出「无变更。」。两者就此自相矛盾：
    // 变更面板会列出一个「改了但没差」的文件。内存 git 只服务于演示面板，够用；
    // 接真实 git 时这条要一起换掉。
    const change = (await git.changes()).find((entry) => entry.path === "a.ts");
    expect(change).toMatchObject({ worktree: "modified", add: 0, del: 0 });
    expect(await git.diff()).toBe("无变更。");
  });
});

describe("内存 git · diff 正文封顶", () => {
  it("单侧最多列 200 行，但头部的增删统计是完整值", async () => {
    // 基线非空是刻意的：两侧都非空才不会引入空串分割产生的空行噪音。
    const fs = createMemoryFileSystem({ "big.txt": "seed" });
    const git = createMemoryGitService(fs);
    const lines = Array.from({ length: 250 }, (_, index) => `line ${index}`);
    await fs.writeFile("big.txt", lines.join("\n"));

    const patch = await git.diff("big.txt");
    const plusLines = patch.split("\n").filter((line) => line.startsWith("+ "));
    expect(plusLines).toHaveLength(200);
    // 封顶只作用于 patch 正文，统计用的是未截断的差集结果
    expect(patch).toContain("（250 增 / 1 删）");
  });
});

describe("内存 git · 行尾", () => {
  it("只把行尾换成 CRLF 不该被判成整篇改动", async () => {
    const fs = createMemoryFileSystem({ "a.ts": "one\ntwo\n" });
    const git = createMemoryGitService(fs);
    // 内容逐字相同，只有行尾从 LF 变 CRLF
    await fs.writeFile("a.ts", "one\r\ntwo\r\n");

    // status 比的是原始字符串，所以仍是 modified —— 这是已知取舍
    expect(await git.status()).toEqual([{ path: "a.ts", status: "modified" }]);
    // 但行差集必须为 0：按 `\n` 拆会让每行多一个尾随 `\r`，整篇变成 2 增 2 删
    expect(await git.diff("a.ts")).toBe("无变更。");
  });

  it("孤立 CR 也算换行（旧 Mac 风格）", async () => {
    const fs = createMemoryFileSystem({ "a.ts": "one\rtwo\r" });
    const git = createMemoryGitService(fs);
    await fs.writeFile("a.ts", "one\ntwo\n");
    expect(await git.diff("a.ts")).toBe("无变更。");
  });
});

describe("内存 git · commit", () => {
  it("commit 把当前快照设为新基线，并让序号递增", async () => {
    const fs = createMemoryFileSystem();
    const git = createMemoryGitService(fs);
    await fs.writeFile("a.ts", "x");

    expect(await git.status()).toEqual([{ path: "a.ts", status: "untracked" }]);
    const first = await git.commit("chore: 第一次");
    expect(first.hash).toMatch(/^a1f0{10}1$/);
    expect(first.message).toBe("chore: 第一次");

    // 基线已重置：同一份内容不再是改动
    expect(await git.status()).toEqual([]);
    expect(await git.diff()).toBe("无变更。");

    await fs.writeFile("b.ts", "y");
    const second = await git.commit("chore: 第二次");
    expect(second.hash).toMatch(/^a1f0{10}2$/);
  });

  it("commit 带上 message 与 ISO 时间戳", async () => {
    const fs = createMemoryFileSystem();
    const git = createMemoryGitService(fs);
    const result = await git.commit("feat: 提交");
    expect(result.message).toBe("feat: 提交");
    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
  });
});
