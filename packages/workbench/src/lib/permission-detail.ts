/**
 * 权限请求的明细提取。
 *
 * agent 把工具入参原样塞在 ACP 的 `rawInput` 里，键名各家自定：opencode 的 bash 用
 * `command`，edit 用 `filepath` + `diff`。宿主只负责透传、不做解析（见
 * acp_host.rs 的 `permission_raw_input`），于是「认不认得出命令」这件事落在这里：
 * 有就显示，没有就不显示——猜错比少一行明细糟得多。
 */

/** 从 rawInput 里取命令正文（execute 类）；取不到返回 null。 */
export function permissionCommand(rawInput: unknown): string | null {
  if (typeof rawInput !== "object" || rawInput === null) return null;
  const command = (rawInput as { command?: unknown }).command;
  return typeof command === "string" && command.trim() ? command.trim() : null;
}

/** 明细截断：命令可能是一整段脚本，卡片里只留开头，避免把输入框顶出屏幕。 */
export function clipPermissionDetail(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
