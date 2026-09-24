/**
 * 宿主命令门面：desktop 走 Tauri IPC，server 走服务端 HTTP，browser-preview 直接拒绝。
 *
 * 这是全仓**唯一**允许 import `@tauri-apps/api/core` 的地方（eslint `no-restricted-imports`
 * 守着），对应 Rust 侧 `crates/greywork-host` 不得依赖 tauri 的那条边界。
 *
 * 函数名与签名刻意与 Tauri 的 `invoke` 保持一致，迁移只改 import 路径、调用点零改动。
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import { API_BASE, errorMessageFrom } from "./error";
import { HostUnavailableError, runtimeMode } from "./runtime";
import { notifyAuthRequired } from "./session";

/** 二进制返回的判据响应头（服务端与 content-type 一起发，用头更抗代理改写）。 */
const BINARY_HEADER = "x-greywork-binary";

/** 401：会话失效，登录门据此区分「该重新登录」与「命令本身失败」。 */
export class HostAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostAuthError";
  }
}

export async function invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
  const mode = runtimeMode();
  // 桌面态转发要保持实参个数：调用点大量用 toHaveBeenCalledWith("cmd") 断言无参调用，
  // 多传一个显式 undefined 会因数组长度不等而失配（语义上两者对 Tauri 等价）。
  if (mode === "desktop") return args === undefined ? tauriInvoke<T>(command) : tauriInvoke<T>(command, args);
  if (mode === "browser-preview") throw new HostUnavailableError(`命令 ${command}`);

  // args 原样透传：服务端命令的入参结构与前端扁平入参同为 camelCase，无需键改写。
  const response = await fetch(`${API_BASE}/command`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, args: args ?? null }),
  });
  if (!response.ok) throw await toError(response, command);
  // 二进制命令返回 ArrayBuffer：与 Tauri IPC 的载荷类型一致，binaryPayload() 零改动可用。
  if (isBinary(response)) return (await response.arrayBuffer()) as T;
  return (await response.json()) as T;
}

function isBinary(response: Response): boolean {
  if (response.headers.get(BINARY_HEADER) === "1") return true;
  return response.headers.get("content-type")?.startsWith("application/octet-stream") ?? false;
}

/**
 * 错误映射。除 401 外都抛普通 Error，message 取服务端 `error` 字段。
 *
 * 调用方的惯例是 `error instanceof Error ? error.message : String(error)`：Tauri 侧
 * `Result<T, String>` 的拒绝值是裸字符串，走的是 `String(error)` 分支；这里抛真 Error
 * 后走 `instanceof` 分支，**可见文案一致**。
 */
async function toError(response: Response, command: string): Promise<Error> {
  const message = await errorMessageFrom(response, `命令 ${command} 失败（HTTP ${response.status}）`);
  if (response.status === 401) {
    notifyAuthRequired();
    return new HostAuthError(message);
  }
  return new Error(message);
}
