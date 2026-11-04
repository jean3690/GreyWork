/**
 * 宿主配置：与 apps/server 的 `ServerConfig` 同名同义，环境变量也逐字对齐。
 *
 * 迁移期最重要的约束是「换后端不换契约」：Electron 的 sidecar-spec 只设这些变量，
 * 所以 Node 宿主必须从同一批 key 读同一份语义，否则同样的启动参数会得到两种行为。
 */
import { readFileSync } from "node:fs";

export interface HostConfig {
  /** 监听地址，来自 GREYWORK_BIND（`host:port`，缺省 127.0.0.1:8787）。 */
  host: string;
  port: number;
  /** 数据目录：db / 通道凭据 / 授权账本都落这里。 */
  dataDir: string;
  /** 静态 SPA 目录；未配置时只提供 API。 */
  staticDir: string | null;
  /** argon2 PHC 串（优先）。 */
  passwordHash: string | null;
  /** 明文密码（dev / 首启便利）；与 passwordHash 二选一。 */
  password: string | null;
  /** 会话有效期（秒），缺省 30 天。 */
  sessionTtlSecs: number;
  /** cookie 是否带 Secure（TLS 反代后应为 true）。 */
  secureCookie: boolean;
  /** 本机可信宿主：环回上的 Electron 窗口。 */
  trustedHost: boolean;
  /** 非空时校验非 GET/HEAD 请求的 Origin。 */
  allowedOrigins: string[];
  /** stdin 读到 EOF 即退出（Electron 的「父死子死」）。 */
  exitOnStdinEof: boolean;
  version: string;
}

const DEFAULT_BIND = "127.0.0.1:8787";
const DEFAULT_TTL_SECS = 30 * 24 * 3600;

function env(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function truthy(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function readVersion(): string {
  // dist/config.js → ../package.json
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof (parsed as { version?: unknown }).version === "string") {
      return (parsed as { version: string }).version;
    }
  } catch {
    // 打包 / 测试环境读不到就回退，不影响启动。
  }
  return "0.0.0";
}

export function loadConfig(envMap: NodeJS.ProcessEnv = process.env): HostConfig {
  const bind = env(envMap, "GREYWORK_BIND") ?? DEFAULT_BIND;
  const split = bind.lastIndexOf(":");
  if (split <= 0) {
    throw new Error(`GREYWORK_BIND 不是 host:port 形态：${bind}`);
  }
  const port = Number(bind.slice(split + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`GREYWORK_BIND 端口非法：${bind}`);
  }
  const ttl = Number(env(envMap, "GREYWORK_SESSION_TTL") ?? DEFAULT_TTL_SECS);
  const dataDir = env(envMap, "GREYWORK_DATA_DIR") ?? new URL("../.data", import.meta.url).pathname;

  return {
    host: bind.slice(0, split),
    port,
    dataDir,
    staticDir: env(envMap, "GREYWORK_STATIC_DIR") ?? null,
    passwordHash: env(envMap, "GREYWORK_PASSWORD_HASH") ?? null,
    password: env(envMap, "GREYWORK_PASSWORD") ?? null,
    sessionTtlSecs: Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_TTL_SECS,
    secureCookie: truthy(env(envMap, "GREYWORK_SECURE_COOKIE")),
    trustedHost: truthy(env(envMap, "GREYWORK_TRUSTED_HOST")),
    allowedOrigins: splitList(env(envMap, "GREYWORK_ALLOWED_ORIGINS")),
    exitOnStdinEof: truthy(env(envMap, "GREYWORK_EXIT_ON_STDIN_EOF")),
    version: readVersion(),
  };
}
