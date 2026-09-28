/**
 * 服务端会话：登录、登出、登录态探测、以及「会话失效」信号。
 *
 * 认证载体是 HttpOnly cookie（`gw_session`），JS 永不持有 token：登录响应里虽然也带 token
 * 字段，但那是给非浏览器客户端走 Bearer 用的；浏览器一律靠 cookie，同源 fetch 自动携带。
 */

import { API_BASE, errorMessageFrom } from "./error";
import { runtimeMode } from "./runtime";

/** 需要重新登录时的订阅者（入口据此重挂登录门）。 */
const authRequiredHandlers = new Set<() => void>();

/** 订阅「会话失效」；返回解绑函数。 */
export function onAuthRequired(handler: () => void): () => void {
  authRequiredHandlers.add(handler);
  return () => {
    authRequiredHandlers.delete(handler);
  };
}

/** 由 invoke 在收到 401 时调用。单个订阅者抛错不能影响其余订阅者。 */
export function notifyAuthRequired(): void {
  for (const handler of [...authRequiredHandlers]) {
    try {
      handler();
    } catch (error) {
      console.error("[host-ipc] onAuthRequired 回调失败", error);
    }
  }
}

/** 当前是否已登录。入口用它决定要不要先弹登录门。 */
export async function hasSession(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/session`, { credentials: "same-origin" });
    return response.ok;
  } catch {
    // 网络不通与「未登录」在入口处处理方式相同：都先弹登录门。
    return false;
  }
}

/** 登录。密码错误（401）与限流（429）都抛 Error，文案取服务端 error 字段。 */
export async function login(password: string): Promise<void> {
  const response = await fetch(`${API_BASE}/login`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    throw new Error(await errorMessageFrom(response, `登录失败（HTTP ${response.status}）`));
  }
}

/**
 * 登出：注销服务端会话并清 cookie。
 *
 * 走直接 `fetch` 而不是命令注册表 —— `/api/logout` 是 HTTP 路由，不是宿主命令。
 *
 * **无论服务端应答如何都发出「会话失效」信号**：登出的语义是「本端不再持有会话」，
 * 若因 401/网络抖动就不发信号，界面会卡在已登录态、只能靠刷新脱身。信号一到，
 * `AuthGate` 重挂登录门，入口再问一次 `/api/session`，服务端若其实没清掉会话也只是
 * 需要重新登录一次，不会更糟。
 *
 * 非服务端态（桌面壳 / 浏览器预览）没有 HTTP 会话，直接 no-op。
 */
export async function logout(): Promise<void> {
  if (runtimeMode() === "server") {
    try {
      await fetch(`${API_BASE}/logout`, {
        method: "POST",
        credentials: "same-origin",
      });
    } catch (error) {
      console.error("[host-ipc] 登出请求失败", error);
    }
  }
  notifyAuthRequired();
}
