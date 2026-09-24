//! API 错误 → HTTP 响应。
//!
//! 统一信封 `{"error": "…"}`：成功响应 body 就是命令返回值本身（与 Tauri `invoke` 的
//! resolve 形态一致），失败一律是「状态码 ≥ 400 + 这个信封」。前端 shim 据此
//! `if (!r.ok) throw new Error((await r.json()).error)`，与 `invoke` 的 reject 对齐。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

#[derive(Debug)]
pub enum ApiError {
    /// 未认证 / 凭证无效 / 会话过期 —— 三者对外不可区分。
    Unauthorized,
    /// 已认证但无权执行（桌面专属命令、黑名单命令、Origin 不允许）。
    Forbidden(String),
    /// 未知命令。
    NotFound(String),
    /// 命令参数或执行失败。
    BadRequest(String),
    /// 登录失败次数超限。
    TooManyRequests,
}

impl ApiError {
    fn status(&self) -> StatusCode {
        match self {
            ApiError::Unauthorized => StatusCode::UNAUTHORIZED,
            ApiError::Forbidden(_) => StatusCode::FORBIDDEN,
            ApiError::NotFound(_) => StatusCode::NOT_FOUND,
            ApiError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ApiError::TooManyRequests => StatusCode::TOO_MANY_REQUESTS,
        }
    }

    fn message(&self) -> String {
        match self {
            ApiError::Unauthorized => "未认证".to_string(),
            ApiError::Forbidden(message)
            | ApiError::NotFound(message)
            | ApiError::BadRequest(message) => message.clone(),
            ApiError::TooManyRequests => "登录尝试过于频繁，请稍后再试".to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status(),
            Json(serde_json::json!({ "error": self.message() })),
        )
            .into_response()
    }
}
