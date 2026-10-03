use super::dto::*;
use super::embeddings::*;
use super::models::*;
use super::sse::*;
use super::transport::*;
use super::*;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use bytes::Bytes;

use crate::workspace_fs::WorkspaceFsAccess;

#[test]
fn completions_url_inserts_default_version_segment() {
    assert_eq!(
        completions_url("https://api.openai.com"),
        "https://api.openai.com/v1/chat/completions"
    );
    assert_eq!(
        completions_url("https://api.openai.com/"),
        "https://api.openai.com/v1/chat/completions"
    );
    assert_eq!(
        completions_url(" http://localhost:11434 "),
        "http://localhost:11434/v1/chat/completions"
    );
}

#[test]
fn completions_url_respects_existing_version_segment() {
    assert_eq!(
        completions_url("https://api.deepseek.com/v1"),
        "https://api.deepseek.com/v1/chat/completions"
    );
    assert_eq!(
        completions_url("https://open.bigmodel.cn/api/paas/v4"),
        "https://open.bigmodel.cn/api/paas/v4/chat/completions"
    );
}

#[test]
fn sse_delta_parses_content_and_ignores_noise_frames() {
    let chunk =
        r#"{"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":"你好"}}]}"#;
    assert_eq!(
        parse_sse_delta(chunk),
        Some(SseDelta {
            content: Some("你好".into()),
            reasoning: None
        })
    );
    // 空 delta：content 为空 → None 字段（不产出事件）
    assert_eq!(
        parse_sse_delta(r#"{"choices":[{"delta":{}}]}"#),
        Some(SseDelta::default())
    );
    // 无 choices 的帧（usage 等）→ None
    assert_eq!(parse_sse_delta(r#"{"usage":{"total_tokens":10}}"#), None);
    assert_eq!(parse_sse_delta("not-json"), None);
}

/// 思考链两种线上形状：reasoning_content（DeepSeek-R1/Qwen3）与 reasoning（Ollama/vLLM）。
#[test]
fn sse_delta_extracts_reasoning_from_both_shapes() {
    assert_eq!(
        parse_sse_delta(r#"{"choices":[{"delta":{"reasoning_content":"先想"}}]}"#),
        Some(SseDelta {
            content: None,
            reasoning: Some("先想".into())
        })
    );
    assert_eq!(
        parse_sse_delta(r#"{"choices":[{"delta":{"reasoning":"再想"}}]}"#),
        Some(SseDelta {
            content: None,
            reasoning: Some("再想".into())
        })
    );
    // 同一帧既有正文又有思考：两个字段都取到
    assert_eq!(
        parse_sse_delta(r#"{"choices":[{"delta":{"content":"答","reasoning_content":"思"}}]}"#),
        Some(SseDelta {
            content: Some("答".into()),
            reasoning: Some("思".into())
        })
    );
}

#[test]
fn endpoint_url_builds_all_openai_paths() {
    assert_eq!(
        endpoint_url("http://localhost:11434", "models"),
        "http://localhost:11434/v1/models"
    );
    assert_eq!(
        endpoint_url("http://localhost:11434/v1/", "embeddings"),
        "http://localhost:11434/v1/embeddings"
    );
    assert_eq!(
        endpoint_url("http://localhost:9000/v1", "audio/transcriptions"),
        "http://localhost:9000/v1/audio/transcriptions"
    );
}

#[test]
fn request_body_includes_sampling_params_only_when_set() {
    let params = InferenceParams {
        temperature: Some(0.2),
        max_tokens: Some(512),
    };
    let body = chat_request_body("m", vec![], "auto", &params);
    assert_eq!(body["temperature"], 0.2);
    assert_eq!(body["max_tokens"], 512);
    let bare = chat_request_body("m", vec![], "auto", &InferenceParams::default());
    assert!(bare.get("temperature").is_none());
    assert!(bare.get("max_tokens").is_none());
}

#[test]
fn collect_model_ids_handles_both_shapes_and_dedups() {
    let openai: serde_json::Value =
        serde_json::from_str(r#"{"data":[{"id":"b"},{"id":"a"},{"id":"a"}]}"#).unwrap();
    assert_eq!(collect_model_ids(&openai), vec!["a", "b"]);
    let ollama: serde_json::Value =
        serde_json::from_str(r#"{"models":[{"name":"qwen2.5"},{"name":"llama3"}]}"#).unwrap();
    assert_eq!(collect_model_ids(&ollama), vec!["llama3", "qwen2.5"]);
    assert!(collect_model_ids(&serde_json::json!({})).is_empty());
}

#[test]
fn parse_embeddings_handles_three_shapes() {
    let openai: serde_json::Value =
        serde_json::from_str(r#"{"data":[{"embedding":[1,2]},{"embedding":[3,4]}]}"#).unwrap();
    assert_eq!(
        parse_embeddings(&openai).unwrap(),
        vec![vec![1.0, 2.0], vec![3.0, 4.0]]
    );
    let batch: serde_json::Value = serde_json::from_str(r#"{"embeddings":[[1,2]]}"#).unwrap();
    assert_eq!(parse_embeddings(&batch).unwrap(), vec![vec![1.0, 2.0]]);
    let single: serde_json::Value = serde_json::from_str(r#"{"embedding":[5,6]}"#).unwrap();
    assert_eq!(parse_embeddings(&single).unwrap(), vec![vec![5.0, 6.0]]);
    assert!(parse_embeddings(&serde_json::json!({"ok":true})).is_err());
}

#[test]
fn completion_body_yields_message_content() {
    let body: serde_json::Value = serde_json::from_str(
        r#"{"choices":[{"message":{"role":"assistant","content":"完整回复"}}]}"#,
    )
    .unwrap();
    assert_eq!(content_from_completion(&body).as_deref(), Some("完整回复"));
    assert_eq!(content_from_completion(&serde_json::Value::Null), None);
}

/// 兼容端点对带图请求可能回 content parts 数组：拼接 text 段，别当成「空回复」。
#[test]
fn completion_body_joins_content_parts_array() {
    let body: serde_json::Value = serde_json::from_str(
            r#"{"choices":[{"message":{"role":"assistant","content":[{"type":"text","text":"看"},{"type":"text","text":"到了"}]}}]}"#,
        )
        .unwrap();
    assert_eq!(content_from_completion(&body).as_deref(), Some("看到了"));
    // 数组里没有 text 段（如只有图片）→ None，交由调用方报「空回复」
    let no_text: serde_json::Value = serde_json::from_str(
        r#"{"choices":[{"message":{"content":[{"type":"image","data":"x"}]}}]}"#,
    )
    .unwrap();
    assert_eq!(content_from_completion(&no_text), None);
}

/// 带图请求的 content parts 数组要原样透传给端点，不能被本层改写。
#[test]
fn request_body_passes_content_parts_through() {
    let parts = serde_json::json!([
        { "type": "text", "text": "这张图有什么问题" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
    ]);
    let messages = vec![LlmChatMessage {
        role: "user".into(),
        content: parts.clone(),
    }];
    let body = chat_request_body("gpt-test", messages, "auto", &InferenceParams::default());
    assert_eq!(body["messages"][0]["content"], parts);
}

#[test]
fn request_body_marks_stream_and_maps_messages() {
    let messages = vec![
        LlmChatMessage {
            role: "system".into(),
            content: serde_json::json!("sys"),
        },
        LlmChatMessage {
            role: "user".into(),
            content: serde_json::json!("hi"),
        },
    ];
    let body = chat_request_body("gpt-test", messages, "high", &InferenceParams::default());
    assert_eq!(body["model"], "gpt-test");
    assert_eq!(body["stream"], true);
    assert_eq!(body["reasoning_effort"], "high");
    assert_eq!(body["messages"].as_array().unwrap().len(), 2);
    assert_eq!(body["messages"][0]["role"], "system");
}

#[test]
fn openai_reasoning_effort_maps_explicit_tiers_only() {
    assert_eq!(openai_reasoning_effort("low"), Some("low"));
    assert_eq!(openai_reasoning_effort("medium"), Some("medium"));
    assert_eq!(openai_reasoning_effort("high"), Some("high"));
    // max 收敛为 high（openai 无 max 档）
    assert_eq!(openai_reasoning_effort("max"), Some("high"));
    // auto / 空 / 未知 → 不传，避免模型拒绝请求
    assert_eq!(openai_reasoning_effort("auto"), None);
    assert_eq!(openai_reasoning_effort(""), None);
    assert_eq!(openai_reasoning_effort("ultra"), None);
    // 大小写不敏感
    assert_eq!(openai_reasoning_effort("HIGH"), Some("high"));
}

#[test]
fn request_body_omits_reasoning_effort_when_auto() {
    let body = chat_request_body("gpt-test", vec![], "auto", &InferenceParams::default());
    assert!(body.get("reasoning_effort").is_none());
}

/// 三种平台写法都要给对：写死 `export` 会让 Windows 用户照做后仍然失败。
#[test]
fn env_set_hint_matches_the_platform_shell() {
    assert_eq!(
        env_set_hint("OPENAI_API_KEY", false),
        "export OPENAI_API_KEY=你的密钥"
    );
    let windows = env_set_hint("OPENAI_API_KEY", true);
    assert!(
        windows.starts_with("set OPENAI_API_KEY="),
        "cmd 用 set: {windows}"
    );
    assert!(
        windows.contains("$env:OPENAI_API_KEY="),
        "PowerShell 用 $env:: {windows}"
    );
    // 两边都不该出现对方平台的写法
    assert!(!env_set_hint("K", true).contains("export "));
    assert!(!env_set_hint("K", false).contains("set K="));
}

fn sse_chunk(json: &str) -> Result<Bytes, reqwest::Error> {
    Ok(Bytes::from(format!("data: {json}\n")))
}

/// 复刻 stream 增量帧的最小形状（choices[0].delta.content）。
fn sse_chunk_delta(text: &str) -> Result<Bytes, reqwest::Error> {
    sse_chunk(&format!(
        r#"{{"choices":[{{"delta":{{"content":"{text}"}}}}]}}"#
    ))
}

#[tokio::test]
async fn drain_sse_emits_deltas_then_done() {
    let stream = futures_util::stream::iter(vec![
        sse_chunk_delta("你"),
        sse_chunk_delta("好"),
        sse_chunk("[DONE]"),
    ]);
    let events = drain_sse(stream, Duration::from_secs(5)).await;
    assert_eq!(
        events,
        vec![
            SseEvent::Delta("你".into()),
            SseEvent::Delta("好".into()),
            SseEvent::Done,
        ]
    );
}

#[tokio::test]
async fn drain_sse_close_without_done_is_clean_end() {
    // 服务端直接关闭连接：无错误事件，调用方按 done 收尾（前端 busy 不卡死）。
    let stream = futures_util::stream::iter(vec![sse_chunk_delta("半")]);
    let events = drain_sse(stream, Duration::from_secs(5)).await;
    assert_eq!(events, vec![SseEvent::Delta("半".into())]);
}

/// 事件是「解析出一条就交付一条」，不是收完整段再一次性铺出来——
/// 发送侧合批的正确性就建立在这个前提上。
#[tokio::test]
async fn drain_sse_into_delivers_each_event_as_it_is_parsed() {
    let stream = futures_util::stream::iter(vec![
        sse_chunk_delta("一"),
        sse_chunk_delta("二"),
        sse_chunk_delta("三"),
    ]);
    let mut seen = Vec::new();
    drain_sse_into(stream, Duration::from_secs(5), |event| {
        seen.push(event);
        false // 第一条就喊停：后续增量不该再被消费
    })
    .await;
    assert_eq!(seen, vec![SseEvent::Delta("一".into())]);
}

/// 把合批器的「上次发车时刻」往前拨，让时间窗分支必然命中——
/// 免得单测靠真实 sleep，CI 上既慢又不稳。
fn backdate(batcher: &mut DeltaBatcher, by: Duration) {
    if let Some(aged) = Instant::now().checked_sub(by) {
        batcher.last_flush = aged;
    }
}

#[test]
fn delta_batcher_holds_empty_buffer_but_flushes_once_the_window_elapsed() {
    let mut batcher = DeltaBatcher::new();
    assert!(batcher.finish().is_none(), "空缓冲不该产出事件");
    backdate(&mut batcher, DELTA_FLUSH_INTERVAL);
    assert_eq!(batcher.push("迟到").as_deref(), Some("迟到"));
}

#[test]
fn delta_batcher_flushes_on_the_byte_threshold() {
    let mut batcher = DeltaBatcher::new();
    // 一次性超过字节阈值：与时间窗无关，必然发车（阈值按字节数判定）
    let big = "x".repeat(DELTA_FLUSH_BYTES);
    assert_eq!(batcher.push(&big).as_deref(), Some(big.as_str()));
    assert!(batcher.finish().is_none(), "发车后缓冲应已清空");
}

/// 合批只该改变事件条数：内容与顺序必须逐字节不变。
/// 前端两处消费方（`stores/chat/stream.ts`、`stores/remote-assistant/pipeline.ts`）都是累加。
/// 不断言「几条事件」而断言拼接结果——避免依赖具体切分点。
#[test]
fn delta_batcher_preserves_order_and_never_loses_the_tail() {
    let mut batcher = DeltaBatcher::new();
    let mut seen = String::new();
    for token in ["前", "中", "后", "尾"] {
        if let Some(batch) = batcher.push(token) {
            seen.push_str(&batch);
        }
    }
    if let Some(batch) = batcher.finish() {
        seen.push_str(&batch);
    }
    assert_eq!(seen, "前中后尾");
}

/// 起本地 mock chat/completions 服务器，返回其 URL。
/// body: 完整响应体；content_type: 响应类型。
async fn mock_completions_server(body: String, content_type: &str) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let content_type = content_type.to_string();
    tokio::spawn(async move {
        // 循环 accept：reqwest 偶发重连/复用连接时，单次 accept 的服务器会让
        // 第二次连接直接撞 RST，客户端侧表现为偶发「error decoding response
        // body」。每连接独立子任务：先吞掉请求（防写响应时对端仍在写导致
        // RST），响应头体一次写完，再显式 shutdown 干净收尾。
        while let Ok((mut stream, _)) = listener.accept().await {
            let body = body.clone();
            let content_type = content_type.clone();
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = vec![0u8; 4096];
                let _ = stream.read(&mut buf).await;
                let mut wire = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .into_bytes();
                wire.extend_from_slice(body.as_bytes());
                let _ = stream.write_all(&wire).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    format!("http://{addr}/v1")
}

fn complete_message(text: &str) -> String {
    format!(r#"{{"choices":[{{"message":{{"role":"assistant","content":"{text}"}}}}]}}"#)
}

/// chat_complete 只在声明的 env 变量非空时才发起请求；CI 与多数本地环境
/// 都没有这个变量（名字带 TEST 前缀，示意无需真实密钥）。测试自设同名同值，
/// 两个用例并行 set 也互不干扰（std env 内部有锁）。
fn mock_api_key_env() -> String {
    const ENV: &str = "GREYWORK_TEST_NO_SUCH_KEY";
    std::env::set_var(ENV, "test-key");
    ENV.to_string()
}

/// 思考链增量与正文增量都从同一个 SSE 流里解析出来，各自成为事件。
#[tokio::test]
async fn drain_sse_emits_thinking_and_content_events() {
    let stream = futures_util::stream::iter(vec![
        sse_chunk(r#"{"choices":[{"delta":{"reasoning_content":"想"}}]}"#),
        sse_chunk_delta("答"),
        sse_chunk("[DONE]"),
    ]);
    let events = drain_sse(stream, Duration::from_secs(5)).await;
    assert_eq!(
        events,
        vec![
            SseEvent::Thinking("想".into()),
            SseEvent::Delta("答".into()),
            SseEvent::Done,
        ]
    );
}

#[tokio::test]
async fn llm_list_models_parses_openai_and_ollama_shapes() {
    let openai = r#"{"data":[{"id":"qwen2.5"},{"id":"llama3.2"}]}"#.to_string();
    let url = mock_completions_server(openai, "application/json").await;
    let models = llm_list_models(ListModelsArgs {
        base_url: url,
        api_key_env: Some(mock_api_key_env()),
        headers: None,
    })
    .await
    .expect("listed");
    assert_eq!(models, vec!["llama3.2", "qwen2.5"]);
}

#[tokio::test]
async fn llm_embed_reads_vectors_and_dim() {
    let body = r#"{"data":[{"embedding":[1,2,3]},{"embedding":[0.5,0.25,0.125]}]}"#.to_string();
    let url = mock_completions_server(body, "application/json").await;
    let result = llm_embed(EmbedArgs {
        base_url: url,
        model: "bge-m3".into(),
        api_key_env: Some(mock_api_key_env()),
        headers: None,
        input: vec!["a".into(), "b".into()],
    })
    .await
    .expect("embedded");
    assert_eq!(result.dim, 3);
    assert_eq!(result.embeddings.len(), 2);
    assert_eq!(result.model, "bge-m3");
}

/// 空输入不该发请求（避免无谓往返），直接回空结果。
#[tokio::test]
async fn llm_embed_empty_input_skips_request() {
    let result = llm_embed(EmbedArgs {
        base_url: "http://127.0.0.1:1".into(),
        model: "m".into(),
        api_key_env: None,
        headers: None,
        input: vec![],
    })
    .await
    .expect("empty ok");
    assert!(result.embeddings.is_empty());
    assert_eq!(result.dim, 0);
}

#[tokio::test]
async fn llm_transcribe_reads_authorized_audio_and_returns_text() {
    let tmp = std::env::temp_dir().join(format!("gw-transcribe-{}", std::process::id()));
    let root = tmp.join("root");
    std::fs::create_dir_all(&root).expect("mkdir");
    let audio = root.join("voice.wav");
    std::fs::write(&audio, b"RIFFfake-audio-bytes").expect("write audio");
    let workspace =
        WorkspaceFsAccess::new(&root, tmp.join("access.json")).expect("workspace access");

    let url =
        mock_completions_server(r#"{"text":"  你好世界  "}"#.to_string(), "application/json").await;
    let result = llm_transcribe(
        &workspace,
        TranscribeArgs {
            base_url: url,
            model: "whisper-1".into(),
            api_key_env: Some(mock_api_key_env()),
            headers: None,
            path: audio.to_string_lossy().to_string(),
            language: Some("zh".into()),
        },
    )
    .await
    .expect("transcribed");
    assert_eq!(result.text, "你好世界");
}

/// 授权面外的路径不得被转写读取（与 fs 读同一条边界）。
#[tokio::test]
async fn llm_transcribe_rejects_unauthorized_path() {
    let tmp = std::env::temp_dir().join(format!("gw-transcribe-deny-{}", std::process::id()));
    let root = tmp.join("root");
    let outside = tmp.join("outside");
    std::fs::create_dir_all(&root).expect("mkdir root");
    std::fs::create_dir_all(&outside).expect("mkdir outside");
    let audio = outside.join("secret.wav");
    std::fs::write(&audio, b"x").expect("write");
    let workspace =
        WorkspaceFsAccess::new(&root, tmp.join("access.json")).expect("workspace access");
    let error = llm_transcribe(
        &workspace,
        TranscribeArgs {
            base_url: "http://127.0.0.1:1".into(),
            model: "whisper-1".into(),
            api_key_env: None,
            headers: None,
            path: audio.to_string_lossy().to_string(),
            language: None,
        },
    )
    .await
    .expect_err("unauthorized");
    assert!(error.contains("未获用户授权"), "{error}");
}

#[tokio::test]
async fn chat_complete_aggregates_sse_stream() {
    let sse = format!(
        "data: {}\ndata: {}\ndata: [DONE]\n",
        serde_json::json!({"choices":[{"delta":{"content":"你"}}]}),
        serde_json::json!({"choices":[{"delta":{"content":"好"}}]})
    );
    let url = mock_completions_server(sse, "text/event-stream").await;
    let reply = chat_complete(
        &url,
        "mock-model",
        &mock_api_key_env(),
        vec![LlmChatMessage {
            role: "user".into(),
            content: serde_json::json!("hi"),
        }],
        "auto",
        &HashMap::new(),
    )
    .await
    .expect("aggregated");
    assert_eq!(reply, "你好");
}

#[tokio::test]
async fn chat_complete_reads_non_stream_json_body() {
    let url = mock_completions_server(complete_message("整包回复"), "application/json").await;
    let reply = chat_complete(
        &url,
        "mock-model",
        &mock_api_key_env(),
        vec![LlmChatMessage {
            role: "user".into(),
            content: serde_json::json!("hi"),
        }],
        "auto",
        &HashMap::new(),
    )
    .await
    .expect("parsed");
    assert_eq!(reply, "整包回复");
}

#[test]
fn header_placeholders_resolve_env_vars() {
    std::env::set_var("GREYWORK_TEST_HEADER_TOKEN", "secret-123");
    assert_eq!(
        resolve_header_placeholders("Bearer {{GREYWORK_TEST_HEADER_TOKEN}}").unwrap(),
        "Bearer secret-123"
    );
    // 多占位符 + 相邻文本
    std::env::set_var("GREYWORK_TEST_HEADER_ORG", "acme");
    assert_eq!(
        resolve_header_placeholders("{{GREYWORK_TEST_HEADER_ORG}}:{{GREYWORK_TEST_HEADER_TOKEN}}")
            .unwrap(),
        "acme:secret-123"
    );
    // 无占位符原样返回；占位符名容忍空白
    assert_eq!(
        resolve_header_placeholders("plain-value").unwrap(),
        "plain-value"
    );
    assert_eq!(
        resolve_header_placeholders("{{ GREYWORK_TEST_HEADER_ORG }}").unwrap(),
        "acme"
    );
}

#[test]
fn header_placeholders_error_on_missing_env() {
    let error = resolve_header_placeholders("{{GREYWORK_TEST_HEADER_MISSING}}").unwrap_err();
    assert!(error.contains("GREYWORK_TEST_HEADER_MISSING"));
    assert!(error.contains("未设置环境变量"));
    // 未闭合的 {{ 按字面量保留（交由 reqwest/服务端判定合法性）
    assert_eq!(
        resolve_header_placeholders("literal {{ open").unwrap(),
        "literal {{ open"
    );
}

#[tokio::test]
async fn drain_sse_idle_timeout_aborts_hung_stream() {
    // 连接保持但零数据：超过 idle 必须终止并报错，而不是永久悬挂。
    // unfold 产出含 async future 非 Unpin：Box::pin 后满足 drain_sse 约束。
    let stream = Box::pin(futures_util::stream::unfold(0u8, |mut state| async move {
        if state == 0 {
            state = 1;
            Some((sse_chunk_delta("前"), state))
        } else {
            tokio::time::sleep(Duration::from_secs(10)).await;
            Some((Ok(Bytes::new()), state))
        }
    }));
    let events = drain_sse(stream, Duration::from_millis(200)).await;
    assert_eq!(events.len(), 2);
    assert_eq!(events[0], SseEvent::Delta("前".into()));
    assert!(matches!(&events[1], SseEvent::Error(message) if message.contains("空闲超时")));
}

/// 性能测量用例：统计发送侧合批前后的 `llm-delta` IPC 事件数。
/// 两种端点节奏各测一轮——合批的触发条件不同（时间窗 vs 字节阈值）。
/// 按需手动运行：
/// `cargo test --lib delta_batch_measurement -- --ignored --nocapture`
#[tokio::test]
#[ignore = "性能测量用例，按需手动运行"]
async fn delta_batch_measurement_counts_ipc_events() {
    const TOKENS: usize = 200;
    for (label, gap_ms) in [("100 tok/s", 10u64), ("无间隔突发", 0)] {
        let chunk = sse_chunk_delta(&"x".repeat(30)).expect("chunk");
        let stream = Box::pin(futures_util::stream::unfold(
            (0usize, chunk),
            move |(index, chunk)| async move {
                if index >= TOKENS {
                    return None;
                }
                if gap_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(gap_ms)).await;
                }
                Some((Ok(chunk.clone()), (index + 1, chunk)))
            },
        ));
        let mut batcher = DeltaBatcher::new();
        let mut raw = 0usize;
        let mut batched = 0usize;
        drain_sse_into(stream, Duration::from_secs(5), |event| {
            if let SseEvent::Delta(delta) = event {
                raw += 1;
                if batcher.push(&delta).is_some() {
                    batched += 1;
                }
            }
            true
        })
        .await;
        if batcher.finish().is_some() {
            batched += 1;
        }
        println!(
            "{label}：{TOKENS} 个 token → 逐条发 {raw} 条 IPC，合批后 {batched} 条（{:.0}×）",
            raw as f64 / batched as f64
        );
        assert!(batched < raw, "合批必须减少事件数");
    }
}
