/**
 * 本机凭据：首启生成强随机密码，转成 argon2 PHC 落盘，之后每次启动自动登录。
 *
 * 为什么同时存明文与 PHC：
 * - sidecar 只吃 **PHC 串**（`GREYWORK_PASSWORD_HASH`），明文因此不进子进程 env；
 * - 但 `/api/login` 要的是**明文**（server 侧 argon2 校验），所以明文也得留着换会话 token。
 * 两者都经 `safeStorage`（OS 钥匙串派生密钥）加密落盘；`safeStorage` 不可用时（少数无钥匙串
 * 后端的 Linux）回落同目录明文文件并告警 —— 仅本机环回可达，与「用户自己看得到自己家目录」
 * 同一信任面。
 *
 * 渲染端不碰密码：token 由主进程换好后塞进窗口 cookie（见 `window.ts`），登录门不会弹。
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";

export interface Credentials {
  /** 明文密码：仅用于 `/api/login` 换 token。 */
  readonly password: string;
  /** argon2 PHC 串：喂给 sidecar 的 `GREYWORK_PASSWORD_HASH`。 */
  readonly hash: string;
}

const encryptedFile = (): string => path.join(app.getPath("userData"), "credentials.bin");
const plainFile = (): string => path.join(app.getPath("userData"), "credentials.json");

/** 调 sidecar 的 `hash-password` 子命令把明文转 PHC。该子命令把提示语也打在 stdout 上。 */
function hashPassword(serverBin: string, password: string): string {
  const out = execFileSync(serverBin, ["hash-password"], {
    input: `${password}\n${password}\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
    // Windows：server 是 console 子系统程序，打包版主进程没有控制台 —— 不抑制就会为这次
    // 首启哈希闪一个控制台窗口（与 sidecar spawn 同一类问题，见 shared/sidecar-spec）。
    windowsHide: true,
  });
  const match = /\$argon2[^\s]+/.exec(out);
  if (!match) throw new Error(`hash-password 未产出 argon2 串：${JSON.stringify(out.slice(0, 200))}`);
  return match[0];
}

function parse(raw: string): Credentials | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object") {
      const { password, hash } = value as Record<string, unknown>;
      if (typeof password === "string" && typeof hash === "string" && password && hash) return { password, hash };
    }
  } catch {
    // 老格式 / 损坏：当作没有，重新生成。
  }
  return null;
}

function readExisting(): Credentials | null {
  if (safeStorage.isEncryptionAvailable() && existsSync(encryptedFile())) {
    try {
      return parse(safeStorage.decryptString(readFileSync(encryptedFile())));
    } catch (error) {
      console.error("[auth] 解密本机凭据失败，将重新生成：", error);
    }
  }
  if (!safeStorage.isEncryptionAvailable() && existsSync(plainFile())) {
    return parse(readFileSync(plainFile(), "utf8"));
  }
  return null;
}

function persist(credentials: Credentials): void {
  const payload = JSON.stringify(credentials);
  try {
    if (safeStorage.isEncryptionAvailable()) {
      writeFileSync(encryptedFile(), safeStorage.encryptString(payload), { mode: 0o600 });
    } else {
      console.warn("[auth] safeStorage 不可用（无钥匙串后端），凭据以明文落盘（仅本机可读）");
      writeFileSync(plainFile(), payload, { mode: 0o600 });
    }
  } catch (error) {
    console.error("[auth] 持久化本机凭据失败（本次会话仍可用）：", error);
  }
}

/** 读出已持久化的凭据；无则生成一套并落盘。 */
export function loadOrCreateCredentials(serverBin: string): Credentials {
  const existing = readExisting();
  if (existing) return existing;
  const password = randomBytes(24).toString("base64url");
  const credentials: Credentials = { password, hash: hashPassword(serverBin, password) };
  persist(credentials);
  return credentials;
}

/** 用本机明文密码向 sidecar 换一个会话 token；失败返回 null（窗口会回落到登录门）。 */
export async function sessionToken(port: number, password: string): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
      // 健康检查已通过，登录不该无限等：后端卡住时让窗口尽快回落登录门。
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    return data !== null && typeof data === "object" && "token" in data && typeof data.token === "string" ? data.token : null;
  } catch (error) {
    console.error("[auth] 自动登录失败：", error);
    return null;
  }
}
