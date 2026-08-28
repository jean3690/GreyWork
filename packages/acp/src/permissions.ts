/** 权限档位 → ACP 确认模式映射（Phase 5）。
 *
 * cautious → confirm-each：每次工具/权限请求逐条弹层确认（CommandBar 已实现确认门）。
 * daily    → confirm-destructive：常规操作放行，破坏性操作确认（mock 期与 Rust YOLO 组合时
 *            由前端在派发前拦截危险意图关键词）。
 * auto     → auto-approve：Rust 主机 YOLO 策略直通。
 */
export type PermissionTier = "cautious" | "daily" | "auto";
export type AcpPermissionMode = "confirm-each" | "confirm-destructive" | "auto-approve";

export function permissionTierToAcpMode(tier: PermissionTier): AcpPermissionMode {
  if (tier === "cautious") return "confirm-each";
  if (tier === "daily") return "confirm-destructive";
  return "auto-approve";
}

/**
 * daily 档的破坏性意图粗筛（派发前语义拦截，防误发）。
 * 注意：真正的工具级守卫已由 Rust 宿主执行——daily 档非只读工具
 * 一律转发前端确认；写类工具（edit/delete/move）路径越出工作区由宿主直接拒绝
 * （见 apps/desktop/src-tauri/src/acp_host.rs 的文件系统锚定）。此处仅做用户
 * 体验层的第一道提示，不承担安全边界职责。
 */
const DESTRUCTIVE_PATTERN = /(删除|rm\s|格式化|format\s|drop\s+table|push\s+--force)/i;

export function isDestructiveIntent(text: string): boolean {
  return DESTRUCTIVE_PATTERN.test(text);
}

/** 派发前置守卫：返回是否允许直接派发（false = 需前端确认弹层）。 */
export function shouldConfirmBeforeDispatch(tier: PermissionTier, text: string): boolean {
  const mode = permissionTierToAcpMode(tier);
  if (mode === "confirm-each") return true;
  if (mode === "confirm-destructive") return isDestructiveIntent(text);
  return false;
}
