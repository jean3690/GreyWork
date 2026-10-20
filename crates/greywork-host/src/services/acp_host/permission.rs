//! 权限请求的转发、裁决回传与待决释放。

use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    PermissionOptionId, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome,
};
use tokio::sync::oneshot;

use crate::host::HostContext;

use super::policy::{decide_permission, kind_label, option_kind_label, PermissionVerdict};
use super::state::{emit, AcpHost, PendingPermission, PermissionDecision};

/// 转发前端后的确认等待上限；超时按取消处理，避免挂死 agent 回合。
const PERMISSION_CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);

/// 权限请求涉及的路径（协议标准字段，跨 agent 通用）。前端卡片据此告诉用户
/// 「这条请求要动哪些文件」——edit 类请求里这比标题有用得多。
fn permission_locations(request: &RequestPermissionRequest) -> Vec<String> {
    request
        .tool_call
        .fields
        .locations
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|location| location.path.to_string_lossy().into_owned())
        .collect()
}

/// rawInput 的透传上限：agent 习惯把整份 diff / 文件正文塞进 rawInput，
/// 无上限地经 IPC + JSON-RPC 各拷一份会拖慢权限卡片。超限直接置 null——
/// 路径有 `locations` 兜底，命令正文丢失只是少一行明细，不值得为它撑大载荷。
pub(super) const PERMISSION_RAW_INPUT_MAX_BYTES: usize = 8 * 1024;

/// 透传 agent 的原始入参（不解析键名：各家 agent 用 `command` / `filepath` /
/// `diff` 都不一致，硬编码等于把宿主绑死在某一个后端上）。超限返回 None。
fn permission_raw_input(request: &RequestPermissionRequest) -> Option<serde_json::Value> {
    let raw = request.tool_call.fields.raw_input.as_ref()?;
    let encoded = serde_json::to_string(raw).ok()?;
    if encoded.len() > PERMISSION_RAW_INPUT_MAX_BYTES {
        return None;
    }
    Some(raw.clone())
}

/// 组装给前端的权限请求载荷；auto=true 表示宿主已代为决策（仅通知流）。
pub(super) fn permission_payload(
    request_id: u64,
    auto: bool,
    chosen: Option<&str>,
    request: &RequestPermissionRequest,
) -> serde_json::Value {
    serde_json::json!({
        "requestId": request_id,
        "auto": auto,
        "chosen": chosen,
        "toolCallId": request.tool_call.tool_call_id.to_string(),
        "title": request.tool_call.fields.title,
        "kind": kind_label(request.tool_call.fields.kind),
        "locations": permission_locations(request),
        "rawInput": permission_raw_input(request),
        "options": request.options.iter().map(|option| serde_json::json!({
            "optionId": option.option_id.to_string(),
            "name": option.name,
            "kind": option_kind_label(option.kind),
        })).collect::<Vec<_>>(),
    })
}

/// 宿主侧权限档位执行：`decide_permission` 定策略，本函数只负责事件发射、
/// 待决登记与等待裁决。
///
/// `handle` 为发起该请求的 agent 句柄——档位与工作区锚定都按 handle 取，
/// 因此并发的多个 agent 各自适用自己启动时的档位与工作区。
pub(super) async fn resolve_permission(
    host: &dyn HostContext,
    acp: &AcpHost,
    handle: u64,
    request: RequestPermissionRequest,
) -> RequestPermissionResponse {
    let policy = acp.policy_for(handle).await;

    match decide_permission(&policy, &request) {
        PermissionVerdict::BlockedReadOnly => {
            emit(
                host,
                "permission-blocked",
                serde_json::json!({
                    "auto": true,
                    "chosen": null,
                    "toolCallId": request.tool_call.tool_call_id.to_string(),
                    "title": request.tool_call.fields.title,
                    "kind": kind_label(request.tool_call.fields.kind),
                    "reason": "read-only",
                    "locations": [],
                }),
            );
            return RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled);
        }
        PermissionVerdict::BlockedOutsideWorkspace(outside) => {
            emit(
                host,
                "permission-blocked",
                serde_json::json!({
                    "auto": true,
                    "chosen": null,
                    "toolCallId": request.tool_call.tool_call_id.to_string(),
                    "title": request.tool_call.fields.title,
                    "kind": kind_label(request.tool_call.fields.kind),
                    "reason": "outside-workspace",
                    "locations": outside.iter().map(|path| path.to_string_lossy().into_owned()).collect::<Vec<_>>(),
                }),
            );
            return RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled);
        }
        PermissionVerdict::AutoAllow(option_id) => {
            emit(
                host,
                "permission-auto",
                permission_payload(
                    u64::MAX,
                    true,
                    Some(option_id.to_string().as_str()),
                    &request,
                ),
            );
            return RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
                SelectedPermissionOutcome::new(option_id),
            ));
        }
        PermissionVerdict::AutoCancel => {
            // Full 档但 agent 没给任何 Allow 选项：无从放行，只能取消。这里必须发事件 ——
            // 否则这条工具调用会**无声消失**，用户既看不到卡片也看不到记录。
            emit(
                host,
                "permission-blocked",
                serde_json::json!({
                    "auto": true,
                    "chosen": null,
                    "toolCallId": request.tool_call.tool_call_id.to_string(),
                    "title": request.tool_call.fields.title,
                    "kind": kind_label(request.tool_call.fields.kind),
                    "reason": "no-allow-option",
                    "locations": permission_locations(&request),
                }),
            );
            return RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled);
        }
        PermissionVerdict::Ask => {}
    }

    // 转发前端：登记 pending 后立即释放锁，再等待裁决（或超时=取消）。
    let rx = {
        let request_id = acp.next_permission_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel::<PermissionDecision>();
        acp.pending_permissions.lock().await.insert(
            request_id,
            PendingPermission {
                handle,
                responder: tx,
            },
        );
        emit(
            host,
            "permission-request",
            permission_payload(request_id, false, None, &request),
        );
        // 系统通知：待裁决请求 120s 后自动取消，窗口不可见时用户会彻底错过。
        host.notify(
            "ACP 权限待裁决",
            &format!(
                "{} · {}（{} 秒内未响应将自动拒绝）",
                kind_label(request.tool_call.fields.kind),
                request
                    .tool_call
                    .fields
                    .title
                    .as_deref()
                    .unwrap_or("未命名工具调用"),
                PERMISSION_CONFIRM_TIMEOUT.as_secs()
            ),
        );
        rx
    };

    match tokio::time::timeout(PERMISSION_CONFIRM_TIMEOUT, rx).await {
        Ok(Ok(PermissionDecision::Select(option_id))) => RequestPermissionResponse::new(
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id)),
        ),
        _ => RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled),
    }
}

/// 前端裁决回传：requestId 对应待决请求；optionId 为空表示拒绝。
pub async fn acp_permission_respond(
    state: &std::sync::Arc<AcpHost>,
    request_id: u64,
    option_id: Option<String>,
) -> Result<(), String> {
    let sender = state
        .pending_permissions
        .lock()
        .await
        .remove(&request_id)
        .ok_or_else(|| format!("unknown permission request {request_id}"))?;
    let decision = match option_id {
        Some(id) => PermissionDecision::Select(PermissionOptionId::from(id)),
        None => PermissionDecision::Cancel,
    };
    let _ = sender.responder.send(decision);
    Ok(())
}

/// 释放某 handle 名下所有待决权限请求（按取消应答），避免 sender 悬挂至超时。
pub(super) async fn release_pending_permissions(state: &AcpHost, handle: u64) {
    let mut pending = state.pending_permissions.lock().await;
    let stale: Vec<u64> = pending
        .iter()
        .filter(|(_, entry)| entry.handle == handle)
        .map(|(id, _)| *id)
        .collect();
    for id in stale {
        if let Some(entry) = pending.remove(&id) {
            let _ = entry.responder.send(PermissionDecision::Cancel);
        }
    }
}
