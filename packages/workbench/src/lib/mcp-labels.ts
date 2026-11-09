/**
 * MCP 展示文案：传输名与「跳过原因」的人话映射。
 *
 * 宿主（`apps/host-node/src/acp.ts` 的 MCP 声明筛选）回的是 `http_unsupported` 这类稳定标识，翻译只发生在展示层；
 * 设置页与对话页头部胶囊共用同一份，避免两处各写一套说法。
 */

import { i18n } from "../i18n";

/** 传输标识 → 展示名。 */
export const MCP_TRANSPORT_LABELS: Record<string, string> = {
  http: "HTTP（streamable）",
  sse: "SSE",
  stdio: "stdio（本地进程）",
};

/** 跳过原因标识 → 当前语言的文案；未收录的标识按原样展示（宿主新增原因时不至于变空白）。 */
export function mcpSkipReasonLabel(reason: string): string {
  const t = i18n.global.t;
  switch (reason) {
    case "http_unsupported":
      return t("chat.mcpSkip.httpUnsupported");
    case "sse_unsupported":
      return t("chat.mcpSkip.sseUnsupported");
    case "missing_url":
      return t("chat.mcpSkip.missingUrl");
    case "missing_command":
      return t("chat.mcpSkip.missingCommand");
    default:
      return reason.startsWith("unknown_transport:")
        ? t("chat.mcpSkip.unknownTransport", { kind: reason.slice("unknown_transport:".length) })
        : reason;
  }
}
