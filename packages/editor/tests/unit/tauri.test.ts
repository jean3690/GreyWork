/**
 * Tauri Git 服务适配器：命令名/参数转发与结果映射（invoke 注入假实现，不碰 Tauri）。
 *
 * 语义对齐点：
 * - 每个命令都把 `root` 回填为第一个参数，宿主侧据此再做授权 + 路径解析；
 * - `diff()` 不传 path 时**不带** `path` 键（宿主侧 Option 语义，null 与缺省不等价）；
 * - `currentBranch()` 做 trim —— 宿主返回裸分支名带尾换行，接口契约里不该有空白。
 */
import { describe, expect, it, vi } from "vitest";
import { createTauriGitService } from "../../src/tauri";
import type { IpclessInvoke } from "../../src/tauri";

function service(impl: IpclessInvoke) {
  return createTauriGitService("/ws", impl);
}

const invoker = () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const invoke = vi.fn<IpclessInvoke>(async (command, args = {}) => {
    calls.push({ command, args });
    return null;
  });
  return { calls, invoke };
};

describe("createTauriGitService", () => {
  it("每个命令都回填 root，不丢其他参数", async () => {
    const { calls, invoke } = invoker();
    await service(invoke).status();
    await service(invoke).changes();
    await service(invoke).commit("改 a");
    expect(calls[0]).toEqual({ command: "git_status", args: { root: "/ws" } });
    expect(calls[1]).toEqual({ command: "git_changes", args: { root: "/ws" } });
    expect(calls[2]).toEqual({
      command: "git_commit",
      args: { root: "/ws", message: "改 a", all: false },
    });
  });

  it("diff 带 path 时传 path，不带时整体缺省（Option 语义）；side 一起带上", async () => {
    const { calls, invoke } = invoker();
    await service(invoke).diff("a.txt");
    await service(invoke).diff();
    await service(invoke).diff("a.txt", true);
    expect(calls[0].args).toEqual({ root: "/ws", path: "a.txt", staged: false });
    expect(calls[1].args).toEqual({ root: "/ws", staged: false });
    expect("path" in calls[1].args).toBe(false);
    expect(calls[2].args).toEqual({ root: "/ws", path: "a.txt", staged: true });
  });

  it("暂存 / 取消暂存的命令形参（单个与全部）", async () => {
    const { calls, invoke } = invoker();
    await service(invoke).stage(["a.txt", "b.txt"]);
    await service(invoke).stageAll();
    await service(invoke).unstage(["a.txt"]);
    await service(invoke).unstageAll();
    expect(calls[0]).toEqual({ command: "git_stage", args: { root: "/ws", paths: ["a.txt", "b.txt"], all: false } });
    expect(calls[1]).toEqual({ command: "git_stage", args: { root: "/ws", paths: [], all: true } });
    expect(calls[2]).toEqual({ command: "git_unstage", args: { root: "/ws", paths: ["a.txt"], all: false } });
    expect(calls[3]).toEqual({ command: "git_unstage", args: { root: "/ws", paths: [], all: true } });
  });

  it("commit 的 all 开关", async () => {
    const { calls, invoke } = invoker();
    await service(invoke).commit("只提交暂存");
    await service(invoke).commit("全部", { all: true });
    expect(calls[0].args).toEqual({ root: "/ws", message: "只提交暂存", all: false });
    expect(calls[1].args).toEqual({ root: "/ws", message: "全部", all: true });
  });

  it("log 只在显式给了 limit/skip 时才带上（宿主是 Option）", async () => {
    const { calls, invoke } = invoker();
    await service(invoke).log();
    await service(invoke).log({ limit: 20 });
    await service(invoke).log({ limit: 20, skip: 40 });
    expect(calls[0]).toEqual({ command: "git_log", args: { root: "/ws" } });
    expect(calls[1].args).toEqual({ root: "/ws", limit: 20 });
    expect(calls[2].args).toEqual({ root: "/ws", limit: 20, skip: 40 });
  });

  it("show 带 path 时传 path，不带时整体缺省", async () => {
    const { calls, invoke } = invoker();
    await service(invoke).show("abc123");
    await service(invoke).show("abc123", "a.txt");
    expect(calls[0]).toEqual({ command: "git_show", args: { root: "/ws", hash: "abc123" } });
    expect("path" in calls[0].args).toBe(false);
    expect(calls[1].args).toEqual({ root: "/ws", hash: "abc123", path: "a.txt" });
  });

  it("currentBranch 去掉宿主尾换行", async () => {
    const invoke = vi.fn<IpclessInvoke>(async () => "feature/x\n");
    expect(await service(invoke).currentBranch()).toBe("feature/x");
  });

  it("结果按接口类型原样透传（camelCase 由宿主保证）", async () => {
    const entries = [{ path: "a.txt", status: "modified" as const, staged: false }];
    const invoke = vi.fn<IpclessInvoke>(async () => entries);
    expect(await service(invoke).status()).toEqual(entries);

    const commit = { hash: "abc123", message: "改 a", timestamp: "2026-01-01T00:00:00+08:00" };
    invoke.mockResolvedValue(commit);
    expect(await service(invoke).commit("改 a")).toEqual(commit);
  });
});
