/**
 * 云端 Office 的扫码授权事实（`office_oauth_*` 命令面）：授权状态 + 授权动作。
 *
 * 与 `office-host.ts` 同构：直接 `invoke`，不另开 backend 模块 —— 命令面本身就是宿主契约，
 * 中间再包一层只会多一处需要同步的映射。区别在于这里既有**只读事实**（`statuses`，供面板
 * 徽标）也有**副作用动作**（`begin` / `submit` / `logout`）。
 *
 * **宿主无状态**：授权会话不在宿主侧，`state` 由 `begin` 生成后交给调用方保管，`submit` 时
 * 原样回传校验。所以 store 只缓存「每个 clientId 当前授权到哪一步」，不持有任何会话。
 *
 * 浏览器预览态没有宿主命令：只读查询静默保持「未知」，动作类抛 `HostUnavailableError`，
 * 让上层把「这里需要桌面端 / 服务端」明说给用户，而不是悄悄 no-op。
 */
import { hasHostCommands, HostUnavailableError, invoke } from "@greywork/host-ipc";
import type { OfficeOAuthConfig } from "@greywork/shell";
import { defineStore } from "pinia";
import { ref } from "vue";

/** 与 `services/office/auth.rs` 的 `OAuthStatus` 对齐（camelCase，令牌绝不下发）。 */
export interface OfficeOAuthStatus {
  authorized: boolean;
  /** 是否已过期（按字面到期时刻判定，不含刷新提前量）。未授权恒为 false。 */
  expired: boolean;
  /** 到期时刻（毫秒时间戳）；未授权时不返回。 */
  expiresAt?: number;
  scope?: string;
  userId?: string;
}

/** 与 `services/office/auth.rs` 的 `OAuthBeginResult` 对齐。 */
export interface OfficeOAuthBeginResult {
  authorizeUrl: string;
  /** 本次授权的一次性凭据；`submit` 时原样回传。 */
  state: string;
}

/** 未授权状态（查不到 / 已退出登录），与 Rust 侧 `OAuthStatus::unauthorized` 一致。 */
const UNAUTHORIZED: OfficeOAuthStatus = { authorized: false, expired: false };

/** 授权徽标文案与色调；`undefined`（尚未查询）与「未授权」区分开，避免误报。 */
export function officeAuthLabel(status: OfficeOAuthStatus | undefined): { text: string; tone: "ok" | "warn" | "muted" } {
  if (!status) return { text: "授权未知", tone: "muted" };
  if (!status.authorized) return { text: "未授权", tone: "muted" };
  return status.expired ? { text: "已过期", tone: "warn" } : { text: "已授权", tone: "ok" };
}

export const useOfficeAuthStore = defineStore("office-auth", () => {
  /** 各 clientId 的授权状态；缺键 = 尚未查询（徽标据此显示「未知」）。 */
  const statuses = ref<Record<string, OfficeOAuthStatus>>({});

  function setStatus(clientId: string, status: OfficeOAuthStatus): void {
    statuses.value = { ...statuses.value, [clientId]: status };
  }

  /**
   * 查一条授权状态。宿主不可用 / 查询失败 → 保持「未知」（不写键），徽标不误报「未授权」。
   *
   * 与 `office-host.ensureOrigins` 同取舍：宁可显示「未知」，也不要因一次失败让用户以为
   * 令牌掉了、去重做一遍授权。
   */
  async function refreshStatus(clientId: string): Promise<void> {
    const id = clientId.trim();
    if (id === "" || !hasHostCommands()) return;
    try {
      setStatus(id, await invoke<OfficeOAuthStatus>("office_oauth_status", { clientId: id }));
    } catch {
      // 宿主不可用：保持未知。
    }
  }

  /** 拼授权页地址并领一个 state。调用方负责打开浏览器并保管 state。 */
  async function begin(client: OfficeOAuthConfig): Promise<OfficeOAuthBeginResult> {
    if (!hasHostCommands()) throw new HostUnavailableError("扫码授权");
    return invoke<OfficeOAuthBeginResult>("office_oauth_begin", { client });
  }

  /** 交回调换 token；成功后顺手刷新该 clientId 的状态缓存。 */
  async function submit(client: OfficeOAuthConfig, callback: string, expectedState?: string): Promise<OfficeOAuthStatus> {
    if (!hasHostCommands()) throw new HostUnavailableError("扫码授权");
    const status = await invoke<OfficeOAuthStatus>("office_oauth_submit", { client, callback, expectedState });
    setStatus(client.clientId.trim(), status);
    return status;
  }

  /** 退出登录：清宿主侧令牌，并把缓存置为未授权。 */
  async function logout(clientId: string): Promise<void> {
    const id = clientId.trim();
    if (id === "") return;
    if (!hasHostCommands()) throw new HostUnavailableError("扫码授权");
    await invoke("office_oauth_logout", { clientId: id });
    setStatus(id, UNAUTHORIZED);
  }

  return { statuses, refreshStatus, begin, submit, logout };
});
