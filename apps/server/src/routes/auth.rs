//! 登录 / 登出 / 会话自省。

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::{self, AuthSession};
use crate::error::ApiError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct LoginRequest {
    pub password: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    /// 同一身份的 Bearer token（cookie 是另一种携带方式，二者等价）。
    pub token: String,
}

/// 校验密码 → 签发会话，同时下发 `Set-Cookie` 与 body 里的 token。
pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<LoginRequest>,
) -> Result<Response, ApiError> {
    let ip = addr.ip();
    if state.throttle.is_blocked(ip) {
        return Err(ApiError::TooManyRequests);
    }
    let Some(token) = state.sessions.login(&body.password) else {
        state.throttle.record_failure(ip);
        // 只报「未认证」，不区分密码错误与其它 —— 单用户无用户名，不存在枚举面。
        return Err(ApiError::Unauthorized);
    };
    state.throttle.record_success(ip);

    let cookie = auth::session_cookie(
        &token,
        state.config.session_ttl(),
        state.config.secure_cookie,
    );
    let cookie = HeaderValue::from_str(&cookie)
        .map_err(|_| ApiError::BadRequest("会话 cookie 构造失败".to_string()))?;
    let mut response = Json(LoginResponse { token }).into_response();
    response.headers_mut().insert(header::SET_COOKIE, cookie);
    Ok(response)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    pub authenticated: bool,
    /// 到期时刻（unix 毫秒）。
    pub expires_at: u64,
}

/// 自省当前会话（前端启动时用它判断要不要弹登录）。
pub async fn session(
    State(state): State<AppState>,
    AuthSession(token): AuthSession,
) -> Result<Json<SessionResponse>, ApiError> {
    let expires_at = state
        .sessions
        .authenticate(&token)
        .ok_or(ApiError::Unauthorized)?;
    Ok(Json(SessionResponse {
        authenticated: true,
        expires_at,
    }))
}

/// 注销当前会话（移除服务端会话 + 清 cookie）。
pub async fn logout(
    State(state): State<AppState>,
    AuthSession(token): AuthSession,
) -> Result<Response, ApiError> {
    state.sessions.logout(&token);
    let cookie = HeaderValue::from_str(&auth::clear_cookie())
        .map_err(|_| ApiError::BadRequest("会话 cookie 构造失败".to_string()))?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(header::SET_COOKIE, cookie);
    Ok(response)
}
