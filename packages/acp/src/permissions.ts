/** Agent 权限档位（前端展示层级；真正的判定边界由 Rust 宿主执行）。 */
export type PermissionTier = "read-only" | "workspace" | "full";

/** 权限选项意图分类（对齐 GreyWork permissionOptions.ts 的模型）。 */
export type PermissionIntent = "allow-once" | "allow-always" | "reject-once" | "reject-always" | "neutral";

/** 工具操作分类：决定 daily 档位是否自动放行、UI 图标/文案选择。 */
export type PermissionOperationKind = "execute" | "edit" | "read" | "fetch" | "tool";

/** ACP 权限选项的原始 kind（宿主转发，透传 agent 侧命名）。 */
export type AcpOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always" | (string & {});

/** 将 ACP 选项 kind 归一化为意图枚举；未知值按 neutral（保守）。 */
export function classifyAcpPermission(kind: string | null | undefined): PermissionIntent {
  switch (kind) {
    case "allow_once":
      return "allow-once";
    case "allow_always":
      return "allow-always";
    case "reject_once":
      return "reject-once";
    case "reject_always":
      return "reject-always";
    default:
      return "neutral";
  }
}

/** 将工具调用 kind（宿主 label）归一化为操作分类；未知按 tool。 */
export function normalizePermissionOperationKind(kind?: string | null): PermissionOperationKind {
  switch (kind) {
    case "exec":
    case "execute":
    case "bash":
      return "execute";
    case "edit":
    case "write":
    case "create":
    case "delete":
    case "move":
      return "edit";
    case "info":
    case "read":
    case "list":
      return "read";
    case "fetch":
    case "search":
    case "web_search":
      return "fetch";
    default:
      return "tool";
  }
}

/** auto 档安全兜底：选第一个 allow-once 选项；无则 null（宿主将取消而非询问）。 */
export function safeAllowOnceId(options: { optionId: string; kind?: AcpOptionKind }[]): string | null {
  return options.find((option) => classifyAcpPermission(option.kind) === "allow-once")?.optionId ?? null;
}

/** 权限面板选项展示模型（去重 + 意图分类后的稳定身份，供渲染 key/测试断言）。 */
export interface PermissionPanelOption {
  id: string;
  value: string;
  label: string;
  intent: PermissionIntent;
}

export function toPermissionPanelOptions(options: { optionId: string; name: string; kind?: AcpOptionKind }[]): PermissionPanelOption[] {
  return options.map((option, index) => ({
    id: `${option.optionId}:${index}`,
    value: option.optionId,
    label: option.name || option.optionId,
    intent: classifyAcpPermission(option.kind),
  }));
}

/**
 * tool-call 原始入参的透传上限，与宿主 `PERMISSION_RAW_INPUT_MAX_BYTES` 对齐。
 * agent 习惯把整份 diff 塞进 rawInput，一个 100KB 的载荷经 IPC / WebSocket 各拷一份
 * 会拖慢权限卡片；超限整块丢弃——路径有 `locations` 兜底，少一行明细不值得撑大载荷。
 */
export const PERMISSION_RAW_INPUT_MAX_BYTES = 8 * 1024;

/** 超过上限返回 null（前端一律按「无明细」渲染），否则原样透传。 */
export function boundedPermissionRawInput(raw: unknown): unknown {
  if (raw === undefined || raw === null) return null;
  const encoded = JSON.stringify(raw);
  return encoded !== undefined && encoded.length > PERMISSION_RAW_INPUT_MAX_BYTES ? null : raw;
}
