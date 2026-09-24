//! WebSocket 事件总线：把 `ServerHost` 发布的事件推给浏览器。
//!
//! 信封 `{"event": "...", "payload": ...}` 对应 Tauri 的 `listen(name, e => e.payload)`。
//! 事件尽力而为（与 Tauri emit 同语义）：订阅者落后时跳过旧事件、不重放；前端重连后
//! 应重跑若干 `*_load` 命令做一次状态对齐。

use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderMap, Uri};
use axum::response::Response;

use crate::auth;
use crate::error::ApiError;
use crate::state::AppState;

const HEARTBEAT_SECS: u64 = 30;

/// 建立事件流。
///
/// 鉴权：cookie 优先（浏览器 WS API 不能设 `Authorization` 头），CLI 可用 `?token=`。
/// 校验失败直接 401，不升级。
pub async fn events(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let token = headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(auth::token_from_cookie)
        .or_else(|| token_from_query(&uri))
        .ok_or(ApiError::Unauthorized)?;
    if state.sessions.authenticate(&token).is_none() {
        return Err(ApiError::Unauthorized);
    }
    Ok(ws.on_upgrade(move |socket| handle_socket(socket, state)))
}

fn token_from_query(uri: &Uri) -> Option<String> {
    uri.query()?.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == "token" && !value.is_empty()).then(|| value.to_string())
    })
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    let mut receiver = state.bus.subscribe();

    // 首推 hello：前端据此确认连接建立并拿到版本。
    let hello = serde_json::json!({
        "event": "host://hello",
        "payload": { "version": env!("CARGO_PKG_VERSION") },
    });
    if socket
        .send(Message::Text(hello.to_string().into()))
        .await
        .is_err()
    {
        return;
    }

    let mut heartbeat = tokio::time::interval(Duration::from_secs(HEARTBEAT_SECS));
    heartbeat.tick().await; // interval 首次立即触发，先消费掉。

    loop {
        tokio::select! {
            received = receiver.recv() => match received {
                Ok(event) => {
                    let text = match serde_json::to_string(&event) {
                        Ok(text) => text,
                        Err(error) => {
                            greywork_host::log::warn(
                                "server",
                                format!("事件序列化失败，已跳过: {error}"),
                            );
                            continue;
                        }
                    };
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    greywork_host::log::warn(
                        "server",
                        format!("WS 订阅者落后，跳过 {skipped} 条事件"),
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
            _ = heartbeat.tick() => {
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
        }
    }
}
