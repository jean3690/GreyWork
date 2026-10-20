//! prompt 组装、发送与停止。

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, ImageContent, PromptRequest, TextContent,
};

use crate::host::HostContext;

use super::artifacts::{now_ms, scan_turn_artifacts};
use super::permission::release_pending_permissions;
use super::state::{emit, AcpHost};

/// 全量停止时留给事件循环刷出 `session/cancel` 的窗口，之后才 abort 回收进程。
const GRACEFUL_STOP_FLUSH: Duration = Duration::from_millis(150);

/// prompt 的附加内容单元（渲染端 `AcpPromptUnit` 的镜像）。
///
/// `rename_all` 只改变体名（Image → "image"），字段名要单独 rename ——
/// 渲染端发的是 camelCase 的 `mimeType`，少这一行会因缺字段整轮派发失败。
#[derive(serde::Deserialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PromptUnit {
    /// 图片：base64 载荷 + mime（协议原生 image 内容块）。
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
    /// 文本：文本附件的内联正文（正文之外的补充说明）。
    Text { text: String },
}

/// 单轮 prompt 的内容块上限：单元数 10、base64 总量 14MB。
/// 渲染端已有更严的采集限额，这里是宿主侧的兜底 —— IPC 与 JSON-RPC 都经不起
/// 一次塞进几十兆的载荷，越界直接拒绝好过把 agent 连接打爆。
pub(super) const PROMPT_MAX_UNITS: usize = 10;
pub(super) const PROMPT_MAX_BASE64_BYTES: usize = 14 * 1024 * 1024;

/// 组装 prompt 内容块：非空正文恒在最前，附件块依序追加。
/// 正文为空（只发附件）时不补 text 块，也不允许整轮内容为空。
pub(super) fn prompt_blocks(
    text: String,
    units: Vec<PromptUnit>,
) -> Result<Vec<ContentBlock>, String> {
    if units.len() > PROMPT_MAX_UNITS {
        return Err(format!("附件过多：最多 {PROMPT_MAX_UNITS} 个"));
    }
    let mut blocks = Vec::new();
    if !text.is_empty() {
        blocks.push(ContentBlock::Text(TextContent::new(text)));
    }
    let mut total = 0usize;
    for unit in units {
        match unit {
            PromptUnit::Image { data, mime_type } => {
                total += data.len();
                if total > PROMPT_MAX_BASE64_BYTES {
                    return Err("附件总量超过 14MB 上限".to_string());
                }
                blocks.push(ContentBlock::Image(ImageContent::new(data, mime_type)));
            }
            PromptUnit::Text { text } => blocks.push(ContentBlock::Text(TextContent::new(text))),
        }
    }
    if blocks.is_empty() {
        return Err("prompt 内容为空".to_string());
    }
    Ok(blocks)
}

/// 发送一轮 prompt；立即返回 `{ turnId }`，回合结果经 `prompt-done` 事件
/// （携带 handle/turnId/response）异步送达——对齐 GreyWork sendMessage 立即
/// ack + message.stream 回流的模型。流式增量经 acp://event 通知。
///
/// 回合登记进 session.turns（turn_id → JSON-RPC request id），acp_stop 可
/// 按 turn_id 发 `$/cancel_request` 精确取消；完成/取消后自动摘除登记。
/// 注意：sessions 锁只在短临界区持有（克隆连接、登记回合）；回合等待在
/// 独立 task 中进行，acp_stop 随时可取得锁发起取消。
pub async fn acp_send(
    host: Arc<dyn HostContext>,
    state: &Arc<AcpHost>,
    handle: u64,
    text: String,
    units: Option<Vec<PromptUnit>>,
) -> Result<serde_json::Value, String> {
    // 短临界区：登记回合后立即释放锁。sent 必须随块返回——SentRequest 的
    // Drop 会向对端发取消请求，块内丢弃等于立即取消本回合。
    // 同时取出产物扫描所需快照：工作区锚定基准 + 回合开始时刻（mtime 过滤下界）。
    let (sent, turn_id, workspace_root, turn_started_ms) = {
        let mut sessions = state.sessions.lock().await;
        let session = sessions
            .get_mut(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        let session_id = session
            .session_id
            .clone()
            .ok_or_else(|| "session not created; call acp_new_session first".to_string())?;
        let blocks = prompt_blocks(text, units.unwrap_or_default())?;
        let sent = session
            .conn
            .clone()
            .send_request(PromptRequest::new(session_id, blocks));
        let turn_id = state.next_turn_id.fetch_add(1, Ordering::SeqCst);
        session.turns.insert(turn_id, sent.id().clone());
        (sent, turn_id, session.workspace_root.clone(), now_ms())
    };

    // 锁外等待回合结果（独立 task）：取消或完成都会唤醒 block_task，
    // 完成后发 prompt-done 并摘除登记。
    let host_task = Arc::clone(&host);
    let acp_task = Arc::clone(state);
    tokio::spawn(async move {
        let response = sent.block_task().await;
        acp_task
            .sessions
            .lock()
            .await
            .get_mut(&handle)
            .map(|session| session.turns.remove(&turn_id));
        // 只对成功回合扫产物：失败/被取消的回合不弹（与前端「失败不假装完成」同语义）。
        // 同步目录遍历放 spawn_blocking，避免阻塞异步 runtime 线程。
        let succeeded = response.is_ok();
        // spawn_blocking 的句柄要在 async 上下文里 await：先解 Option 再进 async 块，
        // 避免把 await 塞进同步 map 闭包。
        let files: Vec<String> = if succeeded {
            match workspace_root {
                Some(root) => {
                    tokio::task::spawn_blocking(move || {
                        // mtime 是秒级粒度：回合首秒内写的文件，其秒值可能早于
                        // turn_started_ms 的毫秒值。下界放宽 2s 兜住粒度差——
                        // 发送瞬间用户几乎不可能同时在改工作区文件，误报面可忽略。
                        scan_turn_artifacts(&root, turn_started_ms.saturating_sub(2000))
                            .into_iter()
                            .map(|path| path.to_string_lossy().into_owned())
                            .collect::<Vec<_>>()
                    })
                    .await
                    .unwrap_or_default()
                }
                None => Vec::new(),
            }
        } else {
            Vec::new()
        };
        match response {
            Ok(result) => {
                let payload = serde_json::to_value(&result).unwrap_or(serde_json::Value::Null);
                emit(
                    host_task.as_ref(),
                    "prompt-done",
                    serde_json::json!({
                        "handle": handle,
                        "turnId": turn_id,
                        "response": payload,
                        "files": files,
                    }),
                );
            }
            Err(error) => {
                emit(
                    host_task.as_ref(),
                    "prompt-done",
                    serde_json::json!({
                        "handle": handle,
                        "turnId": turn_id,
                        "error": error.to_string(),
                    }),
                );
            }
        }
    });

    Ok(serde_json::json!({ "turnId": turn_id }))
}

/// 停止会话或取消单回合：
/// - `turn_id` 为 Some：先发 ACP `session/cancel`（协议正路），再发
///   `$/cancel_request` 兜底；agent 进程与会话保留。对应前端「停止生成」语义——
///   后续仍可继续 prompt。
/// - `turn_id` 为 None：发 `session/cancel` 让 agent 收尾，短暂等待刷出后
///   abort 事件循环任务并回收子进程。
///
/// 两种路径都会释放该 handle 的待决权限请求：被取消的工具调用不会再有人应答，
/// 留着只会挂到 PERMISSION_CONFIRM_TIMEOUT。前端按 handle 串行发起回合
/// （acpBusy 互斥），故按 handle 清理不会误伤并发回合。
pub async fn acp_stop(
    host: Arc<dyn HostContext>,
    state: &Arc<AcpHost>,
    handle: u64,
    turn_id: Option<u64>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&handle)
        .ok_or_else(|| format!("unknown handle {handle}"))?;

    if let Some(turn_id) = turn_id {
        let request_id = session
            .turns
            .remove(&turn_id)
            .ok_or_else(|| format!("unknown or finished turn {turn_id}"))?;
        // ACP 规定的取消入口是 `session/cancel` 通知：agent 收到后应让在途 prompt 以
        // `cancelled` 收尾。只发 JSON-RPC 的 `$/cancel_request` 不够——不少 agent 没实现
        // 这条底层取消（或只把它当传输层断连处理），用户点「停止」后回合仍会跑完。
        // 两者都发：session/cancel 是协议正路，$/cancel_request 作为兜底保留。
        if let Some(session_id) = session.session_id.clone() {
            let _ = session
                .conn
                .send_notification(CancelNotification::new(session_id));
        }
        session
            .conn
            .send_cancel_request(request_id)
            .map_err(|error| format!("cancel turn {turn_id} failed: {error}"))?;
        drop(sessions);
        release_pending_permissions(state, handle).await;
        emit(
            host.as_ref(),
            "turn-cancelled",
            serde_json::json!({ "handle": handle, "turnId": turn_id }),
        );
        return Ok(());
    }

    let session = sessions.remove(&handle).expect("checked above");
    drop(sessions);
    release_pending_permissions(state, handle).await;

    // 先通知 agent 会话作废（best-effort：连接已断则无所谓），再让事件循环
    // 有一小段时间把通知刷进 stdin，最后 abort 回收进程组。abort 在独立任务里
    // 做，命令本身立即返回；此时 session 已从表中摘除，不会再有新请求路由过来。
    if let Some(session_id) = session.session_id.clone() {
        let _ = session
            .conn
            .send_notification(CancelNotification::new(session_id));
    }
    tokio::spawn(async move {
        tokio::time::sleep(GRACEFUL_STOP_FLUSH).await;
        // abort 让连接 future 落地，`acp_process::AgentStdio` 的进程树守卫随之析构，
        // 整棵树一并回收（Windows `taskkill /T`、Unix `killpg`）—— `cmd → npx → node`
        // 的孙子进程不会残留。
        session.task.abort();
        drop(session);
    });
    emit(
        host.as_ref(),
        "stopped",
        serde_json::json!({ "handle": handle }),
    );
    Ok(())
}

/// 取消**指定会话**的当前工作（发 ACP `session/cancel` 通知，不回收进程、不关会话）。
///
/// 与 `acp_stop` 的区别：`acp_stop` 面向本 handle 的主会话（turn_id=None 时整会话回收），
/// 本函数面向**同一连接内的任意会话 id** —— 主要给协议层子代理用（agent 内部子会话共享
/// 同一条 ACP 连接与 handle，但 sessionId 不同于主会话）。RFD: Subagent Sessions 规定
/// 子代理的单独取消用现有 `session/cancel` 指向该子会话 id，因此这里按 sessionId 精确取消。
///
/// 目标会话不存在时由 agent 自行忽略（session/cancel 是通知，无回执），这里仅校验 handle 在册。
/// 不 `drop(sessions)` 后再发：conn 在 session 内，需在锁保护下借用；发送是同步入队，开销极小。
pub async fn acp_cancel_session(
    state: &Arc<AcpHost>,
    handle: u64,
    session_id: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&handle)
        .ok_or_else(|| format!("unknown handle {handle}"))?;
    session
        .conn
        .send_notification(CancelNotification::new(
            agent_client_protocol::schema::v1::SessionId::from(session_id),
        ))
        .map_err(|error| format!("cancel session failed: {error}"))?;
    Ok(())
}
