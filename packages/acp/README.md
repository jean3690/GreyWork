# @greywork/acp

GreyWork 的 ACP（Agent Client Protocol）控制面客户端：会话传输（宿主 IPC / WebSocket）、权限档位映射与事件模型，与 Rust 侧 `acp_host` 对称。

内部包使用源码直出，无需构建即可被上层应用消费；`@greywork/integrations` 以 `AcpAgentAdapter` 组合本包客户端。

## 外部 Agent 前置条件

- 桌面端通过 Rust `acp_host` spawn ACP agent（`opencode acp` / `claude` / `gemini` 等内置预设，见 `acp_host/env.rs::ALLOWED_AGENT_PROGRAMS`），走 stdio JSON-RPC。用户可在 设置 → Agent「新增后端」自配启动命令；自配程序需在本机已安装且在目录中启用，宿主以 `db.enabled_agent_programs` 扩展放行面，shell 元字符拒绝不变。
- OpenCode ≥ 1.18：`opencode acp` 即 server 模式。会话级模型 / 推理力度 / 模式选择走 ACP 原生 `session/set_config_option`：宿主在 session/new 返回中带出 `configOptions`，ChatView 的「ACP · 会话配置」下拉直接切换；未配置模型的 agent 需在其自身配置（`~/.config/opencode/opencode.json`）里给默认值。

## 会话生命周期

- **恢复**：`loadSession` 在宿主侧按能力择优——agent 声明了 `sessionCapabilities.resume` 时先走
  `session/resume`（不重放历史，前端不开回放抑制窗口）；resume 不可用或失败再回落
  `session/load`（重放历史，前端用回放抑制窗口兜住）。两者都不支持时返回错误，调用方静默回落
  `openSession`，保证「发送必达」。
- **释放**：切换对话时前端先对旧会话调 `closeSession`（宿主发 `session/close`），只回收会话、
  不杀 agent 进程；agent 未声明 `close` 时返回 `false`，视为可选的资源回收而不是失败。
- **取消回合**：`stop(handle, turnId)` 先发 ACP `session/cancel` 通知，再发 JSON-RPC
  `$/cancel_request` 兜底——只发后者时，未实现底层取消的 agent 会让回合继续跑完。
- **旧版模式**：`openSession` / `loadSession` 会把 agent 回包里的 `modes` 原样带出；
  `setSessionMode(handle, modeId)` 发 `session/set_mode`。workbench 把它合成为一条 config
  option，agent 主动发出的 `current_mode_update` 由宿主转成 `mode` 事件回填。

## WebSocket 远程连接

浏览器端可通过 `new WebSocketTransport({ url, protocols?, requestTimeoutMs? })` 连接已运行的 ACP agent endpoint。传输层完成 `initialize`、`session/new`、`session/set_config_option`、`session/set_mode`、`session/prompt`、`session/cancel`（按 handle 或按 sessionId，含子代理）、`session/close` 和 JSON-RPC 权限响应，并将 `session/update` 通知转成与桌面端一致的 `session-update` 事件。远程 endpoint 不负责启动本地命令，因此 `startAgent` 的命令参数仅为兼容桌面端接口而保留；会话持久化 / resume / load 依赖桌面宿主，远程传输不代管。

## 子代理（subagent sessions）

支持 agent 内部委派、经 `subagent_update` 宣告的子会话（RFD: Subagent Sessions）。`AcpTransport`
不新增协议方法，子代理事件都走现有 `session/update` 通知透传（宿主 `classify_notification` 的未识别
分支原样转发 `session-update`），由上层 `packages/workbench/src/stores/agent/subagent.ts` 消费：

- `subagent_update`：建立父子归属（outer `sessionId` 为父，`update.sessionId` 为子），按 patch 语义
  更新 title / description / capabilities / state。
- 子会话自身的消息 / 思考 / 工具：按 outer `sessionId` 归属该子代理的独立转录。
- `session_message` / `session_message_chunk`：会话间消息（不是对用户的回答，也不是工具调用）。
- `cancelSession(handle, sessionId)`：对指定会话（含子代理）发 `session/cancel` 通知，不回收进程；
  桌面走 `acp_cancel_session`，远程走同一通知。
