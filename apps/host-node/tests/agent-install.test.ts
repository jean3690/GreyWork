import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { INSTALLABLE_AGENTS, agentBinDir, agentsDir, installAgent, installedAgentBin, type RunNpm } from "../src/agent-install.js";

const roots: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "gw-agent-install-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function shimPath(cwd: string): string {
  return path.join(cwd, "node_modules", ".bin", process.platform === "win32" ? "codebuddy.cmd" : "codebuddy");
}

/** 模拟 npm：校验传入的是白名单固定版本，并在 .bin 落一个可执行桩。 */
const fakeNpm: RunNpm = async (spec, cwd) => {
  expect(spec).toBe(`@tencent-ai/codebuddy-code@${INSTALLABLE_AGENTS.codebuddy.version}`);
  mkdirSync(path.dirname(shimPath(cwd)), { recursive: true });
  writeFileSync(shimPath(cwd), "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") chmodSync(shimPath(cwd), 0o755);
};

describe("agent-install 路径与白名单", () => {
  it("产物目录在授权根下的 agents/node_modules/.bin", () => {
    expect(agentsDir("/ws")).toBe(path.join("/ws", "agents"));
    expect(agentBinDir("/ws")).toBe(path.join("/ws", "agents", "node_modules", ".bin"));
  });

  it("未安装 / 未知 id 都探测为 null", () => {
    const root = makeRoot();
    expect(installedAgentBin(root, "codebuddy")).toBeNull();
    expect(installedAgentBin(root, "not-allowed")).toBeNull();
  });

  it("白名单外的 id 直接拒绝，且不起 npm", async () => {
    const root = makeRoot();
    const runNpm = vi.fn<RunNpm>();
    await expect(installAgent(root, "not-allowed", runNpm)).rejects.toThrow(/unknown installable agent/);
    expect(runNpm).not.toHaveBeenCalled();
  });

  it("白名单固定版本不改、客户端不能传包名", () => {
    expect(INSTALLABLE_AGENTS.codebuddy.package).toBe("@tencent-ai/codebuddy-code");
    expect(INSTALLABLE_AGENTS.codebuddy.version).toBe("2.183.0");
    expect(Object.keys(INSTALLABLE_AGENTS)).toEqual(["codebuddy"]);
  });
});

describe("agent-install 安装流程", () => {
  it("安装后回绝对路径、写好 package.json 与版本标记", async () => {
    const root = makeRoot();
    const result = await installAgent(root, "codebuddy", fakeNpm);
    expect(result.id).toBe("codebuddy");
    expect(result.version).toBe(INSTALLABLE_AGENTS.codebuddy.version);
    expect(result.bin).toBe(shimPath(agentsDir(root)));
    expect(existsSync(result.bin)).toBe(true);
    expect(existsSync(path.join(agentsDir(root), "package.json"))).toBe(true);
    const marker = JSON.parse(readFileSync(path.join(agentsDir(root), "codebuddy.install.json"), "utf8")) as {
      version: string;
    };
    expect(marker.version).toBe(INSTALLABLE_AGENTS.codebuddy.version);
    expect(installedAgentBin(root, "codebuddy")).toBe(result.bin);
  });

  it("版本匹配即幂等：第二次不再起 npm", async () => {
    const root = makeRoot();
    await installAgent(root, "codebuddy", fakeNpm);
    const runNpm = vi.fn<RunNpm>();
    const again = await installAgent(root, "codebuddy", runNpm);
    expect(runNpm).not.toHaveBeenCalled();
    expect(again.bin).toBe(shimPath(agentsDir(root)));
  });

  it("固定版本升级后自动重装（旧标记不命中）", async () => {
    const root = makeRoot();
    await installAgent(root, "codebuddy", fakeNpm);
    writeFileSync(path.join(agentsDir(root), "codebuddy.install.json"), '{"version":"0.0.0"}\n');
    const runNpm = vi.fn<RunNpm>(fakeNpm);
    await installAgent(root, "codebuddy", runNpm);
    expect(runNpm).toHaveBeenCalledTimes(1);
  });

  it("npm 失败时清掉半成品 shim 与标记，不误报已安装", async () => {
    const root = makeRoot();
    const runNpm: RunNpm = async (_spec, cwd) => {
      mkdirSync(path.dirname(shimPath(cwd)), { recursive: true });
      writeFileSync(shimPath(cwd), "broken");
      if (process.platform !== "win32") chmodSync(shimPath(cwd), 0o755);
      throw new Error("npm install 失败（exit 1）");
    };
    await expect(installAgent(root, "codebuddy", runNpm)).rejects.toThrow(/npm install 失败/);
    expect(installedAgentBin(root, "codebuddy")).toBeNull();
    expect(existsSync(path.join(agentsDir(root), "codebuddy.install.json"))).toBe(false);
  });

  it("安装完成却找不到 shim 时报错", async () => {
    const root = makeRoot();
    const runNpm: RunNpm = async () => {
      /* 什么都不落 */
    };
    await expect(installAgent(root, "codebuddy", runNpm)).rejects.toThrow(/未找到 codebuddy 可执行文件/);
  });

  it("并发只跑一次 npm", async () => {
    const root = makeRoot();
    let calls = 0;
    const runNpm: RunNpm = async (spec, cwd) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await fakeNpm(spec, cwd);
    };
    const [first, second] = await Promise.all([installAgent(root, "codebuddy", runNpm), installAgent(root, "codebuddy", runNpm)]);
    expect(calls).toBe(1);
    expect(first.bin).toBe(second.bin);
  });
});
