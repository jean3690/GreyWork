//! 命令端点：把 HTTP 请求路由到共享的 `greywork_host::commands::dispatch`。
//!
//! 这是服务端与桌面端**同一份命令实现**的入口 —— 命令名/入参/返回值都与 Tauri IPC
//! 逐字对齐，差异只在传输与错误信封（见 `crate::error`）。

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderName, HeaderValue};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use greywork_host::commands::{Auth, CommandOutput, COMMANDS};

use crate::auth::AuthSession;
use crate::error::ApiError;
use crate::policy;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct CommandRequest {
    pub command: String,
    /// 缺省视为 `null`；零参命令用 `UnitArgs` 吞掉任意载荷。
    #[serde(default)]
    pub args: Value,
}

/// 命令元数据视图（camelCase，供前端判定 binary / desktopOnly，免硬编码）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandMetaView {
    pub name: &'static str,
    pub auth: &'static str,
    pub desktop_only: bool,
    pub binary: bool,
}

/// 列出全部命令元数据（含桌面专属，供前端灰显）。
pub async fn list_commands(_session: AuthSession) -> Json<Vec<CommandMetaView>> {
    Json(
        COMMANDS
            .iter()
            .map(|meta| CommandMetaView {
                name: meta.name,
                auth: match meta.auth {
                    Auth::Required => "required",
                    Auth::None => "none",
                },
                desktop_only: meta.desktop_only,
                binary: meta.binary,
            })
            .collect(),
    )
}

/// 执行一条命令。
///
/// 判定顺序：未知命令(404) → 桌面专属(403) → 黑名单(403) → 参数夹紧 → dispatch。
/// 命令内部错误统一 400：客户端只关心成败，状态码的语义留给传输层。
pub async fn run_command(
    State(state): State<AppState>,
    _session: AuthSession,
    Json(request): Json<CommandRequest>,
) -> Result<Response, ApiError> {
    let meta = COMMANDS
        .iter()
        .find(|meta| meta.name == request.command)
        .ok_or_else(|| ApiError::NotFound(format!("未知命令: {}", request.command)))?;
    if meta.desktop_only {
        return Err(ApiError::Forbidden(format!(
            "命令 {} 仅桌面端可用",
            meta.name
        )));
    }
    if policy::is_denied(meta.name) {
        return Err(ApiError::Forbidden(format!(
            "命令 {} 在服务端不可用",
            meta.name
        )));
    }

    let args = policy::overlay_args(meta.name, request.args, &state.config);
    match greywork_host::commands::dispatch(meta.name, args, &state.ctx).await {
        Ok(CommandOutput::Json(value)) => {
            let body = serde_json::to_vec(&value)
                .map_err(|error| ApiError::BadRequest(format!("结果序列化失败: {error}")))?;
            Ok(json_response(body))
        }
        Ok(CommandOutput::Binary(bytes)) => Ok(binary_response(bytes)),
        Err(message) => Err(ApiError::BadRequest(message)),
    }
}

fn json_response(body: Vec<u8>) -> Response {
    let mut response = Response::new(Body::from(body));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

fn binary_response(body: Vec<u8>) -> Response {
    let mut response = Response::new(Body::from(body));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    // 显式标记，便于前端在 Content-Type 之外确认（有些代理会改写 Content-Type）。
    response.headers_mut().insert(
        HeaderName::from_static("x-greywork-binary"),
        HeaderValue::from_static("1"),
    );
    response
}
