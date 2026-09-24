/**
 * 服务端会话：登录、登录态探测、以及「会话失效」信号。
 *
 * 认证载体是 HttpOnly cookie（`gw_session`），JS 永不持有 token：登录响应里虽然也带 token
 * 字段，但那是给非浏览器客户端走 Bearer 用的；浏览器一律靠 cookie，同源 fetch 自动携带。
 */

import { API_BASE, errorMessageFrom } from "./error";

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
