/**
 * MCP 展示文案：传输名与「跳过原因」的人话映射。
 *
 * 宿主（Rust `mcp::plan_servers`）回的是 `http_unsupported` 这类稳定标识，翻译只发生在展示层；
 * 设置页与对话页头部胶囊共用同一份，避免两处各写一套说法。
 */

/** 传输标识 → 展示名。 */
export const MCP_TRANSPORT_LABELS: Record<string, string> = {
  http: "HTTP（streamable）",
  sse: "SSE",
  stdio: "stdio（本地进程）",
};

/** 跳过原因标识 → 人话。未收录的标识按原样展示（宿主新增原因时不至于变空白）。 */
export const MCP_SKIP_REASONS: Record<string, string> = {
  http_unsupported: "当前后端不支持 HTTP 传输",
  sse_unsupported: "当前后端不支持 SSE 传输",
  missing_url: "缺少 URL",
  missing_command: "缺少可执行文件路径",
};
