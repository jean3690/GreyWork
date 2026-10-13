//! 媒体流式路由：`GET /api/media?path=<绝对路径>`，支持 HTTP `Range`。
//!
//! 与桌面壳的 `gwmedia://` 协议同义（两侧共用 `workspace_fs::fs_media_slice`）：预览的
//! `<video>` / `<audio>` 直接把这条地址当 `src`，媒体元素按需拉片段、按需 seek，宿主不必
//! 把整份文件读进内存再塞 blob。
//!
//! **鉴权与 `/api/command` 同源**（`AuthSession`，cookie 或 bearer）—— `<video src>` 是同源
//! 子资源请求，浏览器会自动带上会话 cookie，所以不需要额外机制。
//! **授权面与 `fs_read_media` 同源**：路径要落在授权账本里才读得到，未授权一律拒绝。

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use greywork_host::workspace_fs::{fs_media_slice, MediaSlice};

use crate::auth::AuthSession;
use crate::error::ApiError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct MediaQuery {
    pub path: String,
}

/// 读一段媒体。错误统一 400（与 `fs_read_media` 等 `fs_*` 命令同口径：客户端只关心成败，
/// 状态码语义留给传输层）。
pub async fn media(
    State(state): State<AppState>,
    _session: AuthSession,
    Query(query): Query<MediaQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    match fs_media_slice(&state.ctx.services.workspace, &query.path, range)
        .map_err(ApiError::BadRequest)?
    {
        MediaSlice::Full { bytes, mime } => Ok(build(StatusCode::OK, mime, bytes, None)),
        MediaSlice::Partial {
            bytes,
            mime,
            start,
            end,
            total,
        } => Ok(build(
            StatusCode::PARTIAL_CONTENT,
            mime,
            bytes,
            Some(format!("bytes {start}-{end}/{total}")),
        )),
        MediaSlice::Unsatisfiable { total } => {
            let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            if let Ok(value) = HeaderValue::from_str(&format!("bytes */{total}")) {
                response.headers_mut().insert(header::CONTENT_RANGE, value);
            }
            Ok(response)
        }
    }
}

fn build(
    status: StatusCode,
    mime: &'static str,
    bytes: Vec<u8>,
    content_range: Option<String>,
) -> Response {
    let mut response = (status, bytes).into_response();
    let headers = response.headers_mut();
    // `Content-Type` 给错会让媒体元素选错解复用器，`Accept-Ranges` 是它敢不敢拖进度条的
    // 依据 —— 两个都不能省。
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if let Some(value) = content_range.and_then(|value| HeaderValue::from_str(&value).ok()) {
        headers.insert(header::CONTENT_RANGE, value);
    }
    response
}
