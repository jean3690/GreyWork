#!/usr/bin/env node
// pi → ACP 桥（测试用）：对外实现 ACP v1 stdio server，对内驱动 `pi --mode rpc`。
//
// 背景：pi 0.84.4 无原生 ACP 模式，只有自定义 JSONL RPC。本桥把 ACP 的
// initialize / session/new / session/set_config_option / session/prompt /
// $/cancel_request 翻译为 pi RPC 的 prompt / set_model / abort 等命令，
// 并把 pi 的 message_update（text_delta/thinking_delta）映射为 ACP 的
// agent_message_chunk / agent_thought_chunk 通知，使 pi 可被本项目
// agent-client-protocol（Rust）作为标准 ACP agent 驱动。
//
// 用法：pi-acp-adapter.mjs [--model <model-id>] [--provider <provider>]
// 模型缺省 opencode/ling-3.0-flash-fin-free（AgentRouter 线）。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const model =
  args[args.indexOf("--model") + 1] ?? "opencode/ling-3.0-flash-fin-free";
const provider = args[args.indexOf("--provider") + 1] ?? undefined;

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

// ---- pi RPC 子进程管理 ----
let pi = null; // ChildProcess
let piPromptAck = null; // { resolve } 等待 prompt 被接受
let sessionId = null;
let messageId = null;
let aborted = false;
let piReadyResolve = null; // pi 就绪（首个 response 或 agent 事件）门闩
const piReady = new Promise((resolve) => {
  piReadyResolve = resolve;
});

function startPi() {
  const args = ["--mode", "rpc", "--model", model];
  if (provider) args.push("--provider", provider);
  pi = spawn("pi", args, { stdio: ["pipe", "pipe", "inherit"] });
  pi.on("error", (err) => {
    process.stderr.write(`pi spawn error: ${err.message}\n`);
  });
  pi.on("exit", (code) => {
    process.stderr.write(`pi exited: ${code}\n`);
  });
  const rl = createInterface({ input: pi.stdout });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    handlePiEvent(msg);
  });
  // pi 收到 stdin EOF 会静默退出：保持管道打开，直到桥自身退出。
  if (pi.stdin) {
    pi.stdin.on("error", () => {});
  }
}

function piSend(cmd) {
  if (!pi || pi.exitCode !== null) {
    throw new Error("pi subprocess not running");
  }
  pi.stdin.write(JSON.stringify(cmd) + "\n");
}

// ---- pi 事件 → ACP 通知 ----
function handlePiEvent(msg) {
  process.stderr.write(`[bridge] pi event: ${msg.type} ${msg.command ?? ""}\n`);
  if (msg.type === "response") {
    if (msg.command === "prompt") {
      if (piPromptAck) {
        piPromptAck.resolve(msg.success);
        piPromptAck = null;
      }
    }
    return;
  }
  if (msg.type === "message_update") {
    const ev = msg.assistantMessageEvent;
    if (!ev) return;
    if (ev.type === "text_delta" || ev.type === "text_start") {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: ev.delta ?? "" },
          messageId,
        },
      });
    } else if (ev.type === "thinking_delta" || ev.type === "thinking_start") {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: ev.delta ?? "" },
          messageId,
        },
      });
    } else if (ev.type === "toolcall_start") {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCall: {
            toolCallId: ev.id,
            fields: { kind: "execute", title: ev.toolName },
          },
        },
      });
    }
  } else if (msg.type === "agent_settled" || msg.type === "agent_end") {
    // 回合结束：完成所有等待中的 prompt 响应（携带 stopReason）。
    const handlers = piOnSettledHandlers.splice(0);
    for (const handler of handlers) handler();
  }
}

// ---- ACP 请求处理 ----
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    startPi();
    reply(id, { protocolVersion: 1, agentCapabilities: {} });
  } else if (method === "session/new") {
    sessionId = params?.cwd
      ? `pi-${Buffer.from(params.cwd).toString("base64url").slice(0, 12)}`
      : "pi-session";
    messageId = `${sessionId}-msg`;
    // pi 的 RPC 是单会话进程：启动即全新会话，new_session 命令会被
    // 扩展拦截（session_before_switch）并延迟响应，与 prompt 交错导致
    // 回合卡死——这里不发送，直接应答 ACP。
    reply(id, {
      sessionId,
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: model,
          options: [{ value: model, name: model }],
        },
      ],
    });
  } else if (method === "session/set_config_option") {
    // pi 模型切换：忽略 ACP 的 option_id，仅接受 model 类的 value。
    if (params?.option_id === "model" && params?.value) {
      try {
        piSend({ type: "set_model", modelId: params.value });
      } catch (err) {
        reply(id, { error: { code: -32603, message: err.message } });
        return;
      }
    }
    reply(id, {
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: params?.value ?? model,
          options: [{ value: model, name: model }],
        },
      ],
    });
  } else if (method === "session/prompt") {
    // ACP PromptRequest 的载荷字段是 `prompt`（Vec<ContentBlock>），不是 `content`。
    const text = params?.prompt?.[0]?.text ?? "";
    if (!text) {
      reply(id, { error: { code: -32602, message: "empty prompt" } });
      return;
    }
    aborted = false;
    // 等 pi 接受 prompt 后再回复，避免对端提前收尾。
    const ack = new Promise((resolve) => {
      piPromptAck = { resolve };
    });
    try {
      piSend({ type: "prompt", message: text, id: `acp-${id}` });
    } catch (err) {
      reply(id, { error: { code: -32603, message: err.message } });
      return;
    }
    void ack.then((ok) => {
      if (aborted) {
        reply(id, { stopReason: "cancelled" });
        return;
      }
      if (!ok) {
        reply(id, { error: { code: -32603, message: "pi rejected prompt" } });
        return;
      }
      // prompt 被接受后，回合结束由 pi 的 prompt 响应驱动——RPC 模式
      // 的 prompt 命令响应只表示已受理，真正结束以 agent_settled 为准；
      // 桥在 settle 后补发结束（见 handlePiEvent → 结束标记）。
      // 这里回复仅占位，实际结束在收到 agent_settled 后由 below 完成。
      piOnSettledHandlers.push(() => {
        reply(id, { stopReason: "end_turn" });
      });
    });
  } else if (method === "$/cancel_request") {
    aborted = true;
    try {
      piSend({ type: "abort" });
    } catch {
      // pi 可能已退出；忽略
    }
    // 无响应（通知）
  } else {
    // 未实现方法：静默忽略（协议允许）
  }
});

const piOnSettledHandlers = [];
