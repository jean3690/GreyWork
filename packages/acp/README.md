# @greywork/acp

GreyWork 的 ACP（Agent Client Protocol）控制面客户端：会话传输（Tauri IPC / WebSocket）、权限档位映射与事件模型，与 Rust 侧 `acp_host` 对称。

内部包使用源码直出，无需构建即可被上层应用消费；`@greywork/integrations` 以 `AcpAgentAdapter` 组合本包客户端。

## 外部 Agent 前置条件

- 桌面端通过 Rust `acp_host` spawn 白名单内的 ACP agent（`opencode acp` / `claude` / `gemini` 等，见 `acp_host.rs::ALLOWED_AGENT_PROGRAMS`），走 stdio JSON-RPC。
- OpenCode ≥ 1.18：`opencode acp` 即 server 模式。会话级模型 / 推理力度 / 模式选择走 ACP 原生 `session/set_config_option`：宿主在 session/new 返回中带出 `configOptions`，ChatView 的「ACP · 会话配置」下拉直接切换；未配置模型的 agent 需在其自身配置（`~/.config/opencode/opencode.json`）里给默认值。

## WebSocket 远程连接

浏览器端可通过 `new WebSocketTransport({ url, protocols?, requestTimeoutMs? })` 连接已运行的 ACP agent endpoint。传输层完成 `initialize`、`session/new`、`session/set_config_option`、`session/prompt`、`session/cancel` 和 JSON-RPC 权限响应，并将 `session/update` 通知转成与桌面端一致的 `session-update` 事件。远程 endpoint 不负责启动本地命令，因此 `startAgent` 的命令参数仅为兼容桌面端接口而保留。
