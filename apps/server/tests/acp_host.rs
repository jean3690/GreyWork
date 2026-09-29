//! `AcpHost` 命令面直测：走 `commands::dispatch` 跑完 start → new_session → send → stop。
//!
//! 为什么要有它：仓库里原有的 6 个 ACP 集成测试（`apps/desktop/src-tauri/tests/acp_*.rs`
//! 等）**全部绕开了 `AcpHost`**，直接拿 `agent_client_protocol` 的 client 去连 agent，
//! 于是 `acp_start` / `acp_new_session` / `acp_send` 这几条真实命令——也就是前端唯一会走的
//! 那几条——一直零覆盖。这里用同一份假 agent 把它们补齐（跨语言的对应物见
//! `packages/acp/tests/integration/acp-host-server.e2e.test.ts`）。
//!
//! 注意本测试**直接调 `dispatch`**，不经过 HTTP 路由，所以 `policy::overlay_args` 不参与：
//! sandbox/tier 由本测试显式传。那条覆盖由 `apps/server/tests/http.rs` 与 `policy.rs` 的单测负责。

mod common;

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

use common::harness;
use greywork_host::commands::{dispatch, CommandOutput};
use greywork_server::host::ServerEvent;

/// 与桌面侧共用同一份假 agent——两份副本迟早会漂移。
///
/// 路径里的反斜杠换成正斜杠并加引号，与 `acp_flow.rs` 同一处理：
/// `AcpAgent::from_str` 走 POSIX `shell_words`，Windows 风格路径会被拆坏。
fn mock_agent_cmd() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/desktop/src-tauri/tests/mock-acp-agent.mjs");
    format!("node \"{}\"", path.to_string_lossy().replace('\\', "/"))
}

fn json_of(output: CommandOutput) -> Value {
    match output {
        CommandOutput::Json(value) => value,
        CommandOutput::Binary(_) => panic!("该命令应返回 JSON，而不是二进制"),
    }
}

async fn dispatch_json(
    ctx: &greywork_host::commands::CommandContext,
    name: &str,
    args: Value,
) -> Value {
    let output = dispatch(name, args, ctx)
        .await
        .unwrap_or_else(|error| panic!("{name} 应成功，实际失败: {error}"));
    json_of(output)
}

/// 从事件总线里收 `acp://event`，直到出现指定 `kind`。
///
/// 沿途事件按序压进 `collected`，供调用方断顺序（流式 chunk 必须早于回合结束）。
async fn drain_until(
    rx: &mut tokio::sync::broadcast::Receiver<ServerEvent>,
    kind: &str,
    collected: &mut Vec<Value>,
) -> Value {
    loop {
        let event = match tokio::time::timeout(Duration::from_secs(20), rx.recv()).await {
            Ok(Ok(event)) => event,
            // 慢消费者被跳过旧事件：本测试事件数远小于缓冲，出现即说明有别的消费者在抢，
            // 继续收即可。
            Ok(Err(RecvError::Lagged(_))) => continue,
            Ok(Err(RecvError::Closed)) => panic!("事件总线意外关闭"),
            Err(_) => panic!("等待 {kind} 事件超时，已收到: {collected:#?}"),
        };
        if event.event != "acp://event" {
            continue;
        }
        let envelope = event.payload;
        collected.push(envelope.clone());
        if envelope["kind"].as_str() == Some(kind) {
            return envelope;
        }
    }
}

#[tokio::test]
async fn acp_host_drives_a_full_turn_through_dispatch() {
    let h = harness("acp-host");
    let ctx = h.state.ctx.as_ref();
    // 订阅必须早于任何命令：事件尽力而为、不重放。
    let mut rx = h.state.bus.subscribe();
    let root = h.root();
    let root = root.to_string_lossy().to_string();

    let handle = dispatch_json(
        ctx,
        "acp_start",
        json!({
            "agentCmd": mock_agent_cmd(),
            "tier": "read-only",
            // CI 里没有 bwrap，显式关掉，避免探针噪音。
            "sandbox": "off",
            "workspace": root,
        }),
    )
    .await;
    let handle = handle.as_u64().expect("acp_start 应返回数字 handle");

    let mut seen = Vec::new();
    let started = drain_until(&mut rx, "started", &mut seen).await;
    assert_eq!(
        started["payload"]["handle"].as_u64(),
        Some(handle),
        "started 事件应带同一个 handle"
    );

    let opened = dispatch_json(
        ctx,
        "acp_new_session",
        json!({ "handle": handle, "cwd": root }),
    )
    .await;
    assert_eq!(
        opened["sessionId"].as_str(),
        Some("sess-mock-001"),
        "session/new 的 sessionId 来自假 agent"
    );
    assert!(
        opened["configOptions"]
            .as_array()
            .is_some_and(|options| options.iter().any(|option| option["id"] == "model")),
        "假 agent 在 session/new 里回了一个 model 选择器，configOptions 通路应保留它: {opened}"
    );

    let turn = dispatch_json(
        ctx,
        "acp_send",
        json!({ "handle": handle, "text": "hello acp host" }),
    )
    .await;
    let turn_id = turn["turnId"]
        .as_u64()
        .expect("acp_send 应立刻返回数字 turnId");

    let done = drain_until(&mut rx, "prompt-done", &mut seen).await;
    assert_eq!(done["payload"]["turnId"].as_u64(), Some(turn_id));
    assert!(done["payload"]["error"].is_null(), "回合不应报错: {done}");
    assert_eq!(
        done["payload"]["response"]["stopReason"].as_str(),
        Some("end_turn"),
        "回合应以 end_turn 结束: {done}"
    );

    let texts: Vec<&str> = seen
        .iter()
        .filter(|envelope| envelope["kind"] == "session-update")
        .filter_map(|envelope| envelope["payload"]["update"]["content"]["text"].as_str())
        .collect();
    assert!(
        texts.contains(&"echo: hello acp host"),
        "应收到 agent 的 echo chunk，实际收到的文本: {texts:?}\n完整事件: {seen:#?}"
    );

    let chunk_at = seen
        .iter()
        .position(|envelope| envelope["kind"] == "session-update")
        .expect("应有 session-update 事件");
    let done_at = seen
        .iter()
        .position(|envelope| envelope["kind"] == "prompt-done")
        .expect("应有 prompt-done 事件");
    assert!(chunk_at < done_at, "流式 chunk 必须早于 prompt-done");

    // 收尾：停会话并确认进程树被回收（`stopped` 是宿主在父进程退出后才发的）。
    dispatch_json(ctx, "acp_stop", json!({ "handle": handle, "turnId": null })).await;
    let stopped = drain_until(&mut rx, "stopped", &mut seen).await;
    assert_eq!(stopped["payload"]["handle"].as_u64(), Some(handle));
}

#[tokio::test]
async fn acp_start_rejects_program_outside_the_allowlist() {
    let h = harness("acp-host-allowlist");
    let ctx = h.state.ctx.as_ref();
    let root = h.root().to_string_lossy().to_string();

    let error = dispatch(
        "acp_start",
        json!({
            "agentCmd": "definitely-not-allowed-agent acp",
            "tier": "read-only",
            "sandbox": "off",
            "workspace": root,
        }),
        ctx,
    )
    .await
    .expect_err("白名单外的程序必须被拒绝");

    assert!(
        error.contains("is not in the allowed list"),
        "拒绝理由应来自 process_guard 的白名单校验，实际: {error}"
    );
}
