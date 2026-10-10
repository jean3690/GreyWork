//! ACP `session/update` 通知的分类转发。

use agent_client_protocol::schema::v1::SessionNotification;

use crate::host::HostContext;

use super::state::emit;

/// 按 ACP SessionUpdate 变体分类转发为语义事件；未识别的变体保持
/// 原始 `session-update` 载荷（前端既有解析依赖该事件名与形状）。
pub(super) fn classify_notification(host: &dyn HostContext, notification: SessionNotification) {
    use agent_client_protocol::schema::v1::{ContentBlock, SessionUpdate};
    let session_id = notification.session_id.to_string();
    match notification.update {
        SessionUpdate::AgentThoughtChunk(chunk) => {
            if let ContentBlock::Text(text) = chunk.content {
                emit(
                    host,
                    "thought",
                    serde_json::json!({
                        "sessionId": session_id,
                        "text": text.text,
                        "messageId": chunk.message_id,
                    }),
                );
            }
        }
        SessionUpdate::UsageUpdate(usage) => {
            emit(
                host,
                "usage",
                serde_json::json!({
                    "sessionId": session_id,
                    "used": usage.used,
                    "size": usage.size,
                    "cost": usage.cost,
                    "meta": usage.meta,
                }),
            );
        }
        SessionUpdate::AvailableCommandsUpdate(update) => {
            emit(
                host,
                "commands",
                serde_json::json!({
                    "sessionId": session_id,
                    "availableCommands": update.available_commands,
                }),
            );
        }
        SessionUpdate::ConfigOptionUpdate(update) => {
            emit(
                host,
                "config-options",
                serde_json::json!({
                    "sessionId": session_id,
                    "configOptions": update.config_options,
                }),
            );
        }
        _ => {
            let payload = serde_json::to_value(&notification).unwrap_or(serde_json::Value::Null);
            emit(host, "session-update", payload);
        }
    }
}
