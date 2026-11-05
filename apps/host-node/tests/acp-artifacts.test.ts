import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isTurnArtifactFile, scanTurnArtifacts } from "../src/acp-artifacts.js";

const roots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `gw-scan-${label}-`));
  roots.push(root);
  return root;
}

/** 把文件 mtime 拨到 now-ageSecs。 */
function backdate(filePath: string, ageSecs: number): void {
  const when = new Date(Date.now() - ageSecs * 1000);
  utimesSync(filePath, when, when);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("回合产物扫描", () => {
  it("只挑出时间窗内新写的白名单文档", async () => {
    const root = tempRoot("fresh");
    mkdirSync(path.join(root, "reports"));
    mkdirSync(path.join(root, "node_modules/pkg"), { recursive: true });
    mkdirSync(path.join(root, ".hidden"));

    // 命中：新写的白名单文档
    writeFileSync(path.join(root, "data.csv"), "a,b\n");
    writeFileSync(path.join(root, "reports/brief.md"), "# brief");
    // 未命中：白名单但 mtime 早于窗口
    writeFileSync(path.join(root, "reports/old.md"), "old");
    backdate(path.join(root, "reports/old.md"), 3600);
    // 未命中：非白名单扩展名
    writeFileSync(path.join(root, "notes.txt"), "hi");
    writeFileSync(path.join(root, "package.json"), '{"x":1}');
    // 未命中：Office 锁文件与隐藏文件
    writeFileSync(path.join(root, "~$lock.xlsx"), "lock");
    writeFileSync(path.join(root, ".dot.md"), "hidden");
    // 未命中：噪音目录与隐藏目录里的新文档
    writeFileSync(path.join(root, "node_modules/pkg/readme.md"), "dep");
    writeFileSync(path.join(root, ".hidden/secret.md"), "secret");

    const names = (await scanTurnArtifacts(root, Date.now() - 10_000)).map((full) => path.relative(root, full).split(path.sep).join("/"));
    expect(names).toEqual(["data.csv", "reports/brief.md"]);
  });

  it("空目录 / 不存在的根静默返回空", async () => {
    const root = tempRoot("empty");
    expect(await scanTurnArtifacts(root, Date.now() - 10_000)).toEqual([]);
    // 目录不存在 / 无权限路径：静默空，不抛错
    expect(await scanTurnArtifacts(path.join(root, "nope"), 0)).toEqual([]);
  });

  it("isTurnArtifactFile 大小写不敏感，并排除锁文件 / 隐藏 / 备份", () => {
    expect(isTurnArtifactFile("a/b/Report.XLSX")).toBe(true);
    expect(isTurnArtifactFile("简报.PPTX")).toBe(true);
    expect(isTurnArtifactFile("a/notes.txt")).toBe(false);
    expect(isTurnArtifactFile("a/~$report.xlsx")).toBe(false);
    expect(isTurnArtifactFile("a/.report.md")).toBe(false);
    expect(isTurnArtifactFile("a/report.docx~")).toBe(false);
  });
});
