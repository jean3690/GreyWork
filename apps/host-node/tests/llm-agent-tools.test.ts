/**
 * 本机 agent 回合的工具面：只读六件套在工作区授权面内干活。
 *
 * 直接打 executeTool（导出给单测），不起假模型端点 —— 整圈的协议细节（流式、工具回填、
 * 收尾回合）另有覆盖；这里钉住的是「工具返回什么、越界怎么拒、依赖目录要不要跳」。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { executeTool, type ToolPolicy } from "../src/llm-agent.js";
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

/** 写策略：auto = 不问直接写；ask = 走确认回调；deny = 只读。 */
const autoWrite: ToolPolicy = { write: "auto", shell: "deny", confirm: async () => true };
const askWrite = (allow: boolean): ToolPolicy => ({ write: "ask", shell: "deny", confirm: async () => allow });
const askShell = (allow: boolean): ToolPolicy => ({ write: "deny", shell: "ask", confirm: async () => allow });

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

  it("只读档位下 write_file 被拒且不落盘", async () => {
    const { root, access } = makeWorkspace();
    const target = path.join(root, "src", "new.ts");
    const result = await executeTool(access, root, "write_file", { path: "src/new.ts", content: "export {}\n" });
    expect(result.error).toContain("只读");
    expect(existsSync(target)).toBe(false);
  });

  it("auto 档位直接写盘，工具结果带 diff", async () => {
    const { root, access } = makeWorkspace();
    const result = await executeTool(access, root, "write_file", { path: "src/new.ts", content: "export const a = 1;\n" }, autoWrite);
    expect(result.error).toBeNull();
    expect(result.summary).toContain("写入 src/new.ts");
    expect(result.content).toContain("+ export const a = 1;");
    expect(readFileSync(path.join(root, "src", "new.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  it("edit_file 要求 old_text 唯一，replace_all 才能全改", async () => {
    const { root, access } = makeWorkspace();
    writeFileSync(path.join(root, "dup.txt"), "x\nx\n");

    const ambiguous = await executeTool(access, root, "edit_file", { path: "dup.txt", old_text: "x", new_text: "y" }, autoWrite);
    expect(ambiguous.error).toContain("出现了 2 次");
    expect(readFileSync(path.join(root, "dup.txt"), "utf8")).toBe("x\nx\n");

    const all = await executeTool(
      access,
      root,
      "edit_file",
      { path: "dup.txt", old_text: "x", new_text: "y", replace_all: true },
      autoWrite,
    );
    expect(all.error).toBeNull();
    expect(readFileSync(path.join(root, "dup.txt"), "utf8")).toBe("y\ny\n");
  });

  it("ask 档位被拒时文件一点不动，且确认回调能拿到 diff", async () => {
    const { root, access } = makeWorkspace();
    const target = path.join(root, "src", "app.ts");
    const before = readFileSync(target, "utf8");
    const seen: string[] = [];
    const policy: ToolPolicy = {
      write: "ask",
      shell: "deny",
      confirm: async (request) => {
        seen.push(request.title + "\n" + request.diff);
        return false;
      },
    };

    const result = await executeTool(
      access,
      root,
      "edit_file",
      { path: "src/app.ts", old_text: "needle = 1", new_text: "needle = 2" },
      policy,
    );
    expect(result.error).toContain("用户拒绝");
    expect(readFileSync(target, "utf8")).toBe(before);
    expect(seen[0]).toContain("写入 src/app.ts");
    expect(seen[0]).toContain("- const needle = 1;");
    expect(seen[0]).toContain("+ const needle = 2;");
  });

  it("ask 档位允许时正常落盘", async () => {
    const { root, access } = makeWorkspace();
    const result = await executeTool(
      access,
      root,
      "edit_file",
      { path: "src/app.ts", old_text: "needle = 1", new_text: "needle = 2" },
      askWrite(true),
    );
    expect(result.error).toBeNull();
    expect(readFileSync(path.join(root, "src", "app.ts"), "utf8")).toContain("needle = 2");
  });

  it("shell=deny 时 run_shell 不可用", async () => {
    const { root, access } = makeWorkspace();
    const result = await executeTool(access, root, "run_shell", { command: "echo hi" }, autoWrite);
    expect(result.error).toContain("full 档位");
  });

  it("run_shell 允许时执行命令并带回输出", async () => {
    const { root, access } = makeWorkspace();
    const result = await executeTool(access, root, "run_shell", { command: 'node -e "console.log(41 + 1)"' }, askShell(true));
    expect(result.error).toBeNull();
    expect(result.content).toContain("42");
    expect(result.summary).toContain("退出码 0");
  });

  it("run_shell 被拒时命令不执行", async () => {
    const { root, access } = makeWorkspace();
    writeFileSync(path.join(root, "touch.cjs"), "require('fs').writeFileSync('ran.txt','1');\n");
    const seen: string[] = [];
    const policy: ToolPolicy = {
      write: "deny",
      shell: "ask",
      confirm: async (request) => {
        seen.push(request.command ?? "");
        return false;
      },
    };
    const result = await executeTool(access, root, "run_shell", { command: "node touch.cjs" }, policy);
    expect(result.error).toContain("用户拒绝");
    expect(existsSync(path.join(root, "ran.txt"))).toBe(false);
    expect(seen[0]).toBe("node touch.cjs");
  });

  it("非零退出码把输出一起带回（测试失败要看日志）", async () => {
    const { root, access } = makeWorkspace();
    writeFileSync(path.join(root, "fail.cjs"), "console.log('boom');\nprocess.exit(2);\n");
    const result = await executeTool(access, root, "run_shell", { command: "node fail.cjs" }, askShell(true));
    expect(result.error).toContain("退出码 2");
    expect(result.content).toContain("boom");
  });
});
