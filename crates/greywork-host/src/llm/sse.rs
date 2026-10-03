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

/// 一条 SSE data 行里的增量：正文与思考链分开取。
///
/// 思考链有两种线上形状：`delta.reasoning_content`（DeepSeek-R1 / Qwen3）与
/// `delta.reasoning`（Ollama / vLLM）。两种都收，正文与思考各自独立合批下发。
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct SseDelta {
    pub(super) content: Option<String>,
    pub(super) reasoning: Option<String>,
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
    })
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

/// SSE 消费结果。
#[derive(Debug, PartialEq)]
pub(super) enum SseEvent {
    Delta(String),
    Thinking(String),
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
            }
        }
    }
}
