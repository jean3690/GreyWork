/**
 * 本机 agent 回合的工具面：只读六件套在工作区授权面内干活。
 *
 * 直接打 executeTool（导出给单测），不起假模型端点 —— 整圈的协议细节（流式、工具回填、
 * 收尾回合）另有覆盖；这里钉住的是「工具返回什么、越界怎么拒、依赖目录要不要跳」。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { executeTool } from "../src/llm-agent.js";
import { WorkspaceAccess } from "../src/workspace-access.js";

function makeWorkspace(): { root: string; access: WorkspaceAccess } {
  const root = mkdtempSync(path.join(tmpdir(), "gw-agent-tools-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(path.join(root, "src", "app.ts"), "const needle = 1;\n// TODO: 修一下\n");
  writeFileSync(path.join(root, "src", "literal.txt"), "axb\na.b\n");
  writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "needle 在依赖里\n");
  writeFileSync(path.join(root, "outside.txt"), "outside\n");
  const access = new WorkspaceAccess(root, path.join(root, ".ledger.json"));
  access.authorizeSelectedPath(root);
  return { root, access };
}

describe("本机 agent 工具面", () => {
  it("search_text 命中源码但不扫 node_modules", async () => {
    const { root, access } = makeWorkspace();
    const result = await executeTool(access, root, "search_text", { query: "needle" });
    expect(result.error).toBeNull();
    expect(result.content).toContain("src/app.ts:1:");
    expect(result.content).not.toContain("node_modules");
    expect(result.summary).toContain("1 条");
  });

  it("search_text 默认按字面量匹配（正则元字符不作数）", async () => {
    const { root, access } = makeWorkspace();
    const literal = await executeTool(access, root, "search_text", { query: "a.b" });
    expect(literal.content).toContain("src/literal.txt:2:");
    expect(literal.content).not.toContain("axb");

    const regex = await executeTool(access, root, "search_text", { query: "a.b", regex: true });
    expect(regex.content).toContain("axb");
  });

  it("search_text 的 path 不存在时报错，而不是谎报 0 条", async () => {
    const { root, access } = makeWorkspace();
    const result = await executeTool(access, root, "search_text", { query: "needle", path: "nope" });
    expect(result.error).not.toBeNull();
  });

  it("git_status / git_diff 读得到改动", async () => {
    const { root, access } = makeWorkspace();
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, stdio: "pipe" });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
    writeFileSync(path.join(root, "src", "app.ts"), "const needle = 2;\n// TODO: 修一下\n");

    const status = await executeTool(access, root, "git_status", {});
    expect(status.content).toContain("modified src/app.ts");

    const diff = await executeTool(access, root, "git_diff", { path: "src/app.ts" });
    expect(diff.content).toContain("diff --git");
    expect(diff.content).toContain("const needle = 2");
  });

  it("工作区外的路径被授权面拒绝", async () => {
    const { root, access } = makeWorkspace();
    const result = await executeTool(access, root, "read_file", { path: "/etc/passwd" });
    expect(result.error).not.toBeNull();
  });

  it("未知工具给出可用清单，模型据此重试", async () => {
    const { root, access } = makeWorkspace();
    const result = await executeTool(access, root, "rm_rf", {});
    expect(result.error).toContain("search_text");
    expect(result.error).toContain("git_diff");
  });
});
