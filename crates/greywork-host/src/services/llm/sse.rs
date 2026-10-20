//! SSE 增量解析与发送侧合批（纯逻辑，便于单测）。

use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::{Stream, StreamExt};

/// 增量合批时间窗：与渲染端 `stores/chat/stream.ts` 的 40ms flush 节奏对齐。
pub(super) const DELTA_FLUSH_INTERVAL: Duration = Duration::from_millis(40);
/// 增量合批字节阈值：攒够就直接发，避免大段内容被无谓压后。
pub(super) const DELTA_FLUSH_BYTES: usize = 2048;
/// 流式增量合批器（纯逻辑，便于单测）。
///
/// 上游按 token 产出增量，逐条过 IPC 意味着每个 token 一次 serde 序列化 + 一次全量
/// 广播 + 一次 JS 回调；token 密集时这些开销远超内容本身。这里按「时间窗或字节阈值」
/// 合并，`push` 只在需要发车时给出待发文本。
///
/// 取的是「上一条增量到达时刻」而非定时器：增量本身就是节拍，模型正常产出时每个
/// 窗口都会被下一条增量触发；模型中途长停顿则内容多等一拍（下一条增量或回合结束的
/// `finish` 兜底），不会丢内容。
pub(super) struct DeltaBatcher {
    pending: String,
    pub(super) last_flush: Instant,
}

impl DeltaBatcher {
    pub(super) fn new() -> Self {
        Self {
            pending: String::new(),
            last_flush: Instant::now(),
        }
    }

    /// 收下一个增量；返回 `Some(合并后的文本)` 表示该发车了。
    pub(super) fn push(&mut self, delta: &str) -> Option<String> {
        self.pending.push_str(delta);
        if self.pending.len() >= DELTA_FLUSH_BYTES
            || self.last_flush.elapsed() >= DELTA_FLUSH_INTERVAL
        {
            return self.finish();
        }
        None
    }

    /// 强制发车。回合结束 / 报错 / 中止前必须调用，否则最后一段内容会留在缓冲里。
    pub(super) fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        self.last_flush = Instant::now();
        Some(std::mem::take(&mut self.pending))
    }
}

/// 取非空字符串字段：空串视同缺失（端点用它占位，不该产出空事件）。
fn non_empty_str(value: &serde_json::Value, key: &str) -> Option<String> {
    let text = value.get(key)?.as_str()?;
    (!text.is_empty()).then(|| text.to_string())
}

/// 一条 SSE data 行里的增量：正文、思考链与工具调用分片分开取。
///
/// 思考链有两种线上形状：`delta.reasoning_content`（DeepSeek-R1 / Qwen3）与
/// `delta.reasoning`（Ollama / vLLM）。两种都收，正文与思考各自独立合批下发。
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct SseDelta {
    pub(super) content: Option<String>,
    pub(super) reasoning: Option<String>,
    pub(super) tool_calls: Vec<ToolCallChunk>,
}

/// 一条 SSE data 行里的 `tool_calls` 分片。
///
/// 线上形状是**逐 token 累加**的：首片带 `id` / `type` / `function.name`，后续片通常
/// 只带 `function.arguments` 的一小段 JSON 文本。所以 `index` 是唯一的归位依据 ——
/// 取最后一片只会拿到半截 JSON，必须按 index 拼接（见 [`ToolCallAccumulator`]）。
#[derive(Debug, Default, PartialEq, Eq, Clone)]
pub(super) struct ToolCallChunk {
    pub(super) index: usize,
    pub(super) id: Option<String>,
    pub(super) name: Option<String>,
    pub(super) arguments: Option<String>,
}

/// 解析 `delta.tool_calls` 数组为分片序列；非数组 / 空数组 → 空 vec。
fn parse_tool_call_chunks(delta: &serde_json::Value) -> Vec<ToolCallChunk> {
    let Some(items) = delta.get("tool_calls").and_then(|value| value.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            // 缺 index 的分片无法归位：丢掉它，而不是猜它属于哪个调用。
            let index = item.get("index")?.as_u64()? as usize;
            let function = item.get("function");
            Some(ToolCallChunk {
                index,
                id: non_empty_str(item, "id"),
                name: function.and_then(|value| non_empty_str(value, "name")),
                arguments: function.and_then(|value| non_empty_str(value, "arguments")),
            })
        })
        .collect()
}

/// 解析一条 SSE data 行为增量；非流式完整响应由调用方单独处理。
/// 返回 None 表示该行连 choices/delta 都没有（如 usage 帧）。
pub(super) fn parse_sse_delta(data: &str) -> Option<SseDelta> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    let delta = value.get("choices")?.get(0)?.get("delta")?;
    let pick = |key: &str| -> Option<String> {
        let text = delta.get(key)?.as_str()?;
        (!text.is_empty()).then(|| text.to_string())
    };
    let reasoning = pick("reasoning_content").or_else(|| pick("reasoning"));
    Some(SseDelta {
        content: pick("content"),
        reasoning,
        tool_calls: parse_tool_call_chunks(delta),
    })
}

/// 一次模型回合里累积下来的工具调用（`arguments` 已是完整 JSON 文本）。
///
/// `id` 缺失时合成：assistant 消息由本侧构造，只要回填 `tool` 消息时用同一个 id，
/// 协议就自洽 —— 合成 id 让「模型漏发 id」退化成一次可回传给模型自我纠正的普通错误，
/// 而不是静默丢掉整个调用（丢掉的话模型收不到 tool 结果，会原地重复调用同一个工具）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ToolCall {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) arguments: String,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct PendingToolCall {
    index: usize,
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

/// 按 `index` 归位拼接一个回合里的工具调用分片。
#[derive(Debug, Default)]
pub(super) struct ToolCallAccumulator {
    calls: Vec<PendingToolCall>,
    /// 合成 id 的序号：同一个回合里两次漏 id 的调用不能撞号。
    synth_seq: usize,
}

impl ToolCallAccumulator {
    pub(super) fn push(&mut self, chunks: &[ToolCallChunk]) {
        for chunk in chunks {
            let slot = match self.calls.iter().position(|call| call.index == chunk.index) {
                Some(found) => found,
                None => {
                    self.calls.push(PendingToolCall {
                        index: chunk.index,
                        ..Default::default()
                    });
                    self.calls.len() - 1
                }
            };
            let call = &mut self.calls[slot];
            if chunk.id.is_some() {
                call.id = chunk.id.clone();
            }
            if chunk.name.is_some() {
                call.name = chunk.name.clone();
            }
            if let Some(arguments) = &chunk.arguments {
                call.arguments.push_str(arguments);
            }
        }
    }

    /// 取出本回合累积的全部调用（按 index 升序，即模型给出的并行调用顺序）。
    ///
    /// 清空累积器：同一个 accumulator 跨多个回合复用时，上一回合的分片必须丢掉，
    /// 否则新回合的 `index:0` 会续在旧调用的 arguments 后面。
    pub(super) fn take(&mut self) -> Vec<ToolCall> {
        let mut calls = std::mem::take(&mut self.calls);
        calls.sort_by_key(|call| call.index);
        calls
            .into_iter()
            .map(|call| {
                let id = call.id.unwrap_or_else(|| {
                    self.synth_seq += 1;
                    format!("call_synth_{}_{}", call.index, self.synth_seq)
                });
                ToolCall {
                    id,
                    // 同样合成：没有名字就无法路由到任何工具，回传一条「未知工具」错误
                    // 让模型自己纠正，好过让整条 assistant 消息对不上协议。
                    name: call.name.unwrap_or_default(),
                    arguments: call.arguments,
                }
            })
            .collect()
    }
}

/// 非流式完整响应（服务端忽略 stream 时）提取全文。
/// content 可能是 string，也可能是 parts 数组（部分兼容端点对带图请求回数组），后者拼接 text 段。
pub(super) fn content_from_completion(body: &serde_json::Value) -> Option<String> {
    let content = body
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?;
    if let Some(text) = content.as_str() {
        return (!text.is_empty()).then(|| text.to_string());
    }
    let joined: String = content
        .as_array()?
        .iter()
        .filter_map(|part| part.get("text").and_then(|text| text.as_str()))
        .collect();
    (!joined.is_empty()).then_some(joined)
}

/// 非流式完整响应提取工具调用（服务端忽略 `stream:true` 时的一次性形状）。
///
/// 与流式路径的区别：`arguments` 已是完整字符串，不需要分片拼接；仍统一经
/// `ToolCallAccumulator` 走一遍，让缺 id / 缺 name 的合成规则在两条路径上完全一致
/// —— 否则「同一个模型，切不切流」会得到不同的协议行为。
pub(super) fn tool_calls_from_completion(body: &serde_json::Value) -> Vec<ToolCall> {
    let Some(items) = body
        .get("choices")
        .and_then(|value| value.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("tool_calls"))
        .and_then(|value| value.as_array())
    else {
        return Vec::new();
    };
    let chunks: Vec<ToolCallChunk> = items
        .iter()
        .enumerate()
        .map(|(position, item)| {
            let function = item.get("function");
            ToolCallChunk {
                // 非流式一般不带 index，用数组位置兜底；带了就以线上的为准。
                index: item
                    .get("index")
                    .and_then(|value| value.as_u64())
                    .map(|value| value as usize)
                    .unwrap_or(position),
                id: non_empty_str(item, "id"),
                name: function.and_then(|value| non_empty_str(value, "name")),
                arguments: function.and_then(|value| non_empty_str(value, "arguments")),
            }
        })
        .collect();
    let mut accumulator = ToolCallAccumulator::default();
    accumulator.push(&chunks);
    accumulator.take()
}

/// SSE 消费结果。
#[derive(Debug, PartialEq)]
pub(super) enum SseEvent {
    Delta(String),
    Thinking(String),
    /// 一条（或多条）工具调用分片；交给累积器归位，本身还不是完整调用。
    ToolCalls(Vec<ToolCallChunk>),
    Done,
    Error(String),
}

/// 消费 openai SSE 字节流并收集为事件序列（`drain_sse_into` 的收集式包装）。
pub(super) async fn drain_sse(
    stream: impl Stream<Item = Result<Bytes, reqwest::Error>> + Unpin,
    idle: Duration,
) -> Vec<SseEvent> {
    let mut events = Vec::new();
    drain_sse_into(stream, idle, |event| {
        events.push(event);
        true
    })
    .await;
    events
}

/// 逐事件消费 openai SSE 字节流：每解析出一条就立刻交给 `sink`，不等整段响应收完。
///
/// `sink` 返回 `false` 表示不再需要后续事件，消费立即停止；终止事件（`Done` /
/// `Error`）交付后总是返回，它们的返回值不被检查。
///
/// 空闲（无任何字节）超过 `idle` 按错误提前终止。
pub(super) async fn drain_sse_into(
    mut stream: impl Stream<Item = Result<Bytes, reqwest::Error>> + Unpin,
    idle: Duration,
    mut sink: impl FnMut(SseEvent) -> bool,
) {
    let mut buffer = String::new();
    loop {
        let chunk = match tokio::time::timeout(idle, stream.next()).await {
            Err(_) => {
                sink(SseEvent::Error(format!(
                    "LLM 响应空闲超时（{} 秒无数据）",
                    idle.as_secs()
                )));
                return;
            }
            Ok(None) => return, // 服务端关闭连接：调用方按结束处理
            Ok(Some(Err(error))) => {
                sink(SseEvent::Error(error.to_string()));
                return;
            }
            Ok(Some(Ok(bytes))) => bytes,
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(position) = buffer.find('\n') {
            let line: String = buffer.drain(..=position).collect();
            let line = line.trim_end_matches(['\r', '\n']);
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                sink(SseEvent::Done);
                return;
            }
            if let Some(delta) = parse_sse_delta(data) {
                if let Some(content) = delta.content {
                    if !sink(SseEvent::Delta(content)) {
                        return;
                    }
                }
                if let Some(reasoning) = delta.reasoning {
                    if !sink(SseEvent::Thinking(reasoning)) {
                        return;
                    }
                }
                // 工具调用排在正文与思考之后：一帧里三者同现时，模型先说话再调工具。
                if !delta.tool_calls.is_empty() && !sink(SseEvent::ToolCalls(delta.tool_calls)) {
                    return;
                }
            }
        }
    }
}
