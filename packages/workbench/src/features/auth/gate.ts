/**
 * 登录门判定：只有服务端态需要登录，且以 `/api/session` 的实际应答为准。
 *
 * 不缓存判定结果：会话可能在任意时刻失效（服务端重启、cookie 过期、token 轮换），
 * 每次进门前重新问一次。调用点只有「挂载时」与「收到 401 重弹时」两处，代价可忽略。
 *
 * 桌面态与浏览器预览态都不需要登录：前者是本地壳，没有会话概念；后者没有宿主。
 */
import { hasSession, runtimeMode } from "@greywork/host-ipc";

export async function needsLogin(): Promise<boolean> {
  if (runtimeMode() !== "server") return false;
  return !(await hasSession());
}
