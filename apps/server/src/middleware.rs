//! 全局中间件：安全响应头 + Origin 校验（CSRF 纵深防御）。

use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::state::AppState;

/// 给所有响应加 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`。
///
/// `no-store`：命令返回值可能含凭据/文件内容，不该被任何中间缓存留存。
/// `nosniff`：避免浏览器把 JSON/二进制按内容猜成可执行类型。
///
/// 缓存头用 `or_insert`（**只在缺失时兜底**）：静态路由会先写好各自的按路径策略
/// （`/` 与其余资源 `no-cache`、`/assets/*` `immutable`），这里是更外层的 layer，
/// 若用 `insert` 会把它们全部冲掉。`/api/*` 不设自己的缓存头，于是仍拿到 `no-store`。
pub async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers
        .entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

/// 对非 GET/HEAD/OPTIONS 请求校验 `Origin`。
///
/// `SameSite=Strict` cookie 已是主防线（跨站请求根本不带 cookie）；这里是纵深：
/// 配置了 `allowed_origins` 时，凡不在白名单内的 Origin 一律 403。未配置时跳过
/// —— 同源部署无需维护白名单。
pub async fn origin_guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if state.config.allowed_origins.is_empty() {
        return next.run(request).await;
    }
    if matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) {
        return next.run(request).await;
    }
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let allowed = origin
        .map(|origin| {
            state
                .config
                .allowed_origins
                .iter()
                .any(|item| item == origin)
        })
        .unwrap_or(false);
    if !allowed {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Origin 不被允许" })),
        )
            .into_response();
    }
    next.run(request).await
}
