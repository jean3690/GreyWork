/**
 * 按需安装的 ACP agent（首启下载，不随安装包分发）。
 *
 * 为什么走 npm 而不是解 tarball：这些 CLI 是 Node 包，带真实运行依赖（codebuddy 依赖
 * `@agentclientprotocol/sdk` / `@openai/agents-core` 及其传递依赖），单独解出 `package/`
 * 会缺依赖跑不起来。固定版本 + 服务端白名单是关键：客户端只能传 id，不接受任意包名、
 * 版本或命令，避免远程装任意包。
 *
 * 产物落在 `<授权根>/agents/`（授权根 = ~/.greyWork，见 index.ts 的 defaultRoot）。
 * 宿主启动把 `<agents>/node_modules/.bin` 前置进 PATH，探测（acp_detect_programs 的纯 stat）
 * 与 spawn（AcpHost.start 的 env）走同一条路径，渲染端无需注入 env.PATH。
 *
 * 前置条件：本机 Node 22+ / npm 在 PATH、联网（首次）。与现有 7 个 npx 型预设同一前提。
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface InstallableAgent {
  id: string;
  /** npm 包名（含 scope）。 */
  package: string;
  /** 固定版本；升级只改这里一处。 */
  version: string;
  /** 安装后 `<agents>/node_modules/.bin` 下的可执行名（不含扩展名）。 */
  bin: string;
}

/** 服务端白名单：客户端只能按 id 引用，不能塞包名 / 版本 / 命令。 */
export const INSTALLABLE_AGENTS: Readonly<Record<string, InstallableAgent>> = Object.freeze({
  codebuddy: {
    id: "codebuddy",
    package: "@tencent-ai/codebuddy-code",
    version: "2.183.0",
    bin: "codebuddy",
  },
});

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export function agentsDir(root: string): string {
  return path.join(root, "agents");
}

export function agentBinDir(root: string): string {
  return path.join(agentsDir(root), "node_modules", ".bin");
}

/** 安装标记：记录实际装进去的版本，让固定版本升级后能自动重装，而不是一直命中旧桩。 */
function installMarker(root: string, id: string): string {
  return path.join(agentsDir(root), `${id}.install.json`);
}

function installedVersion(root: string, id: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(installMarker(root, id), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** 已安装则返回可执行文件绝对路径，否则 null。Windows 的 npm shim 是 `.cmd`。 */
export function installedAgentBin(root: string, id: string): string | null {
  const spec = INSTALLABLE_AGENTS[id];
  if (!spec) return null;
  const name = process.platform === "win32" ? `${spec.bin}.cmd` : spec.bin;
  const candidate = path.join(agentBinDir(root), name);
  try {
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

/** 可替换的 npm 调用：测试里注入假实现，避免单测联网装 330MB 的包。 */
export type RunNpm = (spec: string, cwd: string) => Promise<void>;

function tail(chunks: string[], max = 20): string {
  return chunks.join("").split(/\r?\n/).slice(-max).join("\n");
}

export const runNpmInstall: RunNpm = (spec, cwd) =>
  new Promise<void>((resolve, reject) => {
    const proc = spawn("npm", ["install", "--no-save", "--no-audit", "--no-fund", "--no-package-lock", spec], {
      cwd,
      // 继承 npm_config_registry 等配置，不硬编码镜像源。
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Windows 上 npm 是 .cmd 包装，交给 cmd 解析才能命中 PATHEXT；不传 --prefix，
      // 路径经 cwd 传递，避免「路径带空格 + shell:true」的引号坑。
      shell: process.platform === "win32",
      windowsHide: true,
    });
    const out: string[] = [];
    const err: string[] = [];
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => out.push(chunk));
    proc.stderr?.on("data", (chunk: string) => err.push(chunk));

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`npm install 超时（10 分钟）：${spec}`));
    }, INSTALL_TIMEOUT_MS);

    proc.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`npm 启动失败（需本机 Node 22+/npm 在 PATH）：${error.message}`));
    });
    proc.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npm install 失败（exit ${code}）：${spec}\n${tail(err) || tail(out)}`));
    });
  });

export interface InstalledAgent {
  id: string;
  version: string;
  /** 可执行文件绝对路径。 */
  bin: string;
}

const inflight = new Map<string, Promise<InstalledAgent>>();

/**
 * 安装（幂等）：版本匹配且可执行文件在则直接返回；并发只跑一次；失败清掉半成品 shim
 * 与安装标记，避免探测误报「已安装」。
 */
export async function installAgent(root: string, id: string, runNpm: RunNpm = runNpmInstall): Promise<InstalledAgent> {
  const spec = INSTALLABLE_AGENTS[id];
  if (!spec) throw new Error(`unknown installable agent: ${id}`);

  const existing = installedAgentBin(root, id);
  if (existing && installedVersion(root, id) === spec.version) {
    return { id, version: spec.version, bin: existing };
  }

  const key = `${root}\0${id}`;
  const pending = inflight.get(key);
  if (pending) return pending;

  const job = (async (): Promise<InstalledAgent> => {
    const dir = agentsDir(root);
    mkdirSync(dir, { recursive: true });
    const pkgJson = path.join(dir, "package.json");
    if (!existsSync(pkgJson)) {
      writeFileSync(pkgJson, `${JSON.stringify({ name: "greywork-agents", private: true }, null, 2)}\n`);
    }

    try {
      await runNpm(`${spec.package}@${spec.version}`, dir);
    } catch (error) {
      // 半成品 shim 会让 PATH 探测误报「已安装」。
      const shim = path.join(agentBinDir(root), process.platform === "win32" ? `${spec.bin}.cmd` : spec.bin);
      rmSync(shim, { force: true });
      rmSync(installMarker(root, id), { force: true });
      throw error;
    }

    const bin = installedAgentBin(root, id);
    if (!bin) throw new Error(`安装完成但未找到 ${spec.bin} 可执行文件：${agentBinDir(root)}`);
    writeFileSync(installMarker(root, id), `${JSON.stringify({ id, package: spec.package, version: spec.version, bin }, null, 2)}\n`);
    return { id, version: spec.version, bin };
  })();

  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}
