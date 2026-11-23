// spawn 失败（例如 Windows 上 npm 全局命令的 .cmd 包装缺失、或 PATH 里没有该程序）
// 必须是可捕获的错误，而不是未捕获异常：宿主进程一退，Electron 的 sidecar 监视器就会 quit 整个应用。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AcpHost } from "../src/acp.js";
import { EventBus } from "../src/events.js";
import { WorkspaceAccess } from "../src/workspace-access.js";

const root = mkdtempSync(path.join(tmpdir(), "gw-acp-spawn-"));
const host = new AcpHost(new EventBus(), new WorkspaceAccess(root, path.join(root, "ledger.json")));

afterAll(() => {
  host.disposeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("AcpHost · 启动失败", () => {
  it("命令找不到时抛可捕获错误并回收会话，不会带走宿主", async () => {
    // PATH 置空 = 运行环境里找不到 opencode；Linux/macOS 上 spawn 会直接 ENOENT。
    await expect(host.start([], "opencode acp", "workspace", { PATH: "" })).rejects.toThrow(/agent 启动失败/);
    expect(host.sessionCount()).toBe(0);
  });

  it("进程 cwd 必须在授权面内：越界路径直接拒绝，不静默回落到授权根", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "gw-acp-outside-"));
    try {
      await expect(host.start([], "opencode acp", "workspace", { PATH: "" }, outside)).rejects.toThrow(/授权/);
      expect(host.sessionCount()).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
