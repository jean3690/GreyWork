# 原生 Agent Loop 与第三方模型

GreyWork 的原生 agent loop 在 Node 宿主运行，不依赖外部 ACP agent。模型负责决定调用哪些工具，宿主负责权限检查、工具执行、结果回填和下一轮请求。

## 接入第三方模型

1. 在 **设置 → Agent → 新增供应商** 中填写名称、Base URL 和模型 ID。
2. 填写 API Key 并保存到宿主，或填写宿主环境变量名。匿名本地服务把环境变量名留空。
3. 新增时默认勾选 **Agent 模式**。模型不支持工具调用时取消勾选，仅用于聊天。已有配置不会自动开启。
4. 在编辑供应商中点击 **测试工具调用**。测试会发送两次模型请求，验证工具参数、结果回填和最终回答，可能产生供应商费用；不会读写工作区、执行命令或调用 MCP。
5. 保存兼容性参数后，在输入框底部的 **模型与后端** 下拉中选择「本机模型」下的该供应商（或「自动（首个可用）」），即可切回 Local 路径，而不是外部 ACP 后端。

**协议范围：** 当前支持 OpenAI 兼容的 **Chat Completions**（`/chat/completions`）。原生 Anthropic Messages、OpenAI Responses 和 Ollama `/api/chat` 不是同一协议，需使用其 OpenAI 兼容接口或兼容网关。供应商 `kind` 不会自动转换协议。

模型 ID 可以手动输入；服务不支持 `GET /models` 不影响聊天和工具调用。工具测试失败不能仅靠“拉取模型成功”判断可用。

### Base URL 规则

| 配置                                         | 实际聊天地址                                                  |
| -------------------------------------------- | ------------------------------------------------------------- |
| `http://localhost:11434`                     | `http://localhost:11434/v1/chat/completions`                  |
| `https://gateway.example/v1`                 | `https://gateway.example/v1/chat/completions`                 |
| `https://gateway.example/openai`             | `https://gateway.example/openai/chat/completions`             |
| `https://gateway.example/compatible-mode/v1` | `https://gateway.example/compatible-mode/v1/chat/completions` |

裸域名补 `/v1`；显式路径原样保留、不再插入额外 `/v1`。也可填写完整 `/chat/completions` 地址，宿主会识别并统一拼接资源路径。查询参数保留。只接受 HTTP(S)，拒绝地址内的账号密码和 URL 片段。

### 兼容性参数

默认使用流式输出。第三方网关不支持 SSE 时可关闭；宿主仍能处理工具调用和整包 JSON 响应。

**自定义请求参数** 是顶层 JSON 对象，与采样和推理配置合并。例如：

```json
{
  "max_completion_tokens": 8192,
  "temperature": null,
  "top_p": 0.9
}
```

- `max_completion_tokens` 替代旧的 `max_tokens`，避免同时发送两个 token 上限字段。
- 顶层 `null` 表示不发送该参数，适合移除某些模型不支持的 `temperature` 或 `reasoning_effort`。
- 嵌套对象原样发送，例如 `chat_template_kwargs`；是否支持由供应商决定。
- 不允许覆盖 `model`、`messages`、`tools`、`tool_choice`、`stream`、`functions`、`function_call` 或 `n`，避免破坏宿主管理的循环与工具配对。
- 不要在请求参数中填写密钥。凭证走宿主密钥库；自定义 Headers 的敏感值使用 `{{ENV_VAR}}` 占位符。

扩展参数和流式开关随供应商保存，用于聊天、原生 agent 和工具调用测试。启用供应商回退时，切换后的请求按备用供应商自己的参数重建。

## 工具与权限

| 档位        | 可用能力                                                      |
| ----------- | ------------------------------------------------------------- |
| `read-only` | 读文件、列目录、搜索文本、Git 日志/状态/diff、读取技能        |
| `workspace` | 上述能力 + 写文件/编辑文件 + MCP；写入与 MCP 每次确认         |
| `full`      | 写入与 MCP 自动放行；命令执行只在本机可信宿主开放，且每次确认 |

文件工具复用宿主工作区授权，不能因为模型提出要求而越过授权根。取消回合只拒绝该回合自己的待确认操作，不影响并发会话，也不会启动该回合后续工具。已经完成的写入不会因取消而撤销。

## 循环护栏

- 默认最多 12 轮工具调用，硬上限 32；达到上限再发送一次 `tool_choice: "none"` 收尾。
- SSE 工具名和参数按 `index` 累积；保留推理字段用于需要 `reasoning_content` 的模型继续下一轮。
- 流提前断开、输出达到 token 上限、错误 JSON 或不匹配的协议都会明确报错，不执行可能被截断的工具调用。
- 连接等待与响应体空闲分别超时；持续输出的长回复不会被固定 60 秒总时长误杀。
- 工具漏传 `content` / `new_text` 时返回参数错误，不默认为空文本造成数据丢失。
- 上下文预算用于折叠较早的工具结果，保留最近两条和工具调用配对。这是估算护栏，不是精确 tokenizer 或保证能容纳所有输入的硬限制。
- 多供应商回退适用于网络错误、401/403、408、425、429 和 5xx；400 等请求/协议错误不自动切换。开始消费响应后的断流会终止本轮，避免重放工具或重复显示半截输出。

实现入口：`apps/host-node/src/llm-agent.ts`；公共请求与无副作用测试：`apps/host-node/src/llm.ts`；响应解析：`apps/host-node/src/llm-response.ts`。
