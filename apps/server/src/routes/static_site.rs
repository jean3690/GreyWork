//! 同源托管前端构建产物（SPA）。
//!
//! 前端是 **hash 路由**（`createWebHashHistory()`）→ 深链 `/#/…` 永不落到服务端，
//! 所以唯一需要的 HTML 路由就是 `/`。这里刻意**不做 SPA catch-all**：catch-all 会让
//! 打错的 `/assets/x.js` 返回 200 + index.html，既污染缓存又掩盖问题；`ServeDir` 默认
//! 的 404 才是对的。
//!
//! 认证是逐 handler 的提取器（`AuthSession`），不是中间件 —— 本模块不带它，
//! 于是静态资源天然公开（登录表单必须能加载，这是刻意的）。

use std::path::Path;

use axum::http::{header, HeaderValue};
use axum::Router;
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::state::AppState;

/// 静态资源子路由。只在 `GREYWORK_STATIC_DIR` 配好时被 [`crate::build_router`] merge。
pub fn router(dir: &Path) -> Router<AppState> {
    // 1) index.html：绝不缓存 —— 它引用的是带内容哈希的 chunk，部署后必须立刻生效。
    let index = Router::new()
        .route_service("/", ServeFile::new(dir.join("index.html")))
        .layer(cache("no-cache"));

    // 2) /assets/*：Vite 内容哈希命名 → 内容变则文件名变，可永久缓存。
    let assets = Router::new()
        .fallback_service(ServeDir::new(dir.join("assets")))
        .layer(cache("public, max-age=31536000, immutable"));

    // 3) 其余（pdfjs/、vscode-icons/、logo.svg 等）：可缓存但需每次重验证。
    //    append_index_html_on_directories(false)：别让未知路径返回 index.html
    //    （否则打错的资源 404 会被一份 HTML 顶掉，排查困难）。
    let rest = Router::new()
        .fallback_service(ServeDir::new(dir).append_index_html_on_directories(false))
        .layer(cache("no-cache"));

    // axum 0.8：`nest_service("/")` 会 panic（根不可嵌套），所以 `/assets` 走
    // `fallback_service` + `nest("/assets", …)`。`merge` 只在一侧有自定义 fallback 时
    // 才安全 —— 这里 index/nest 侧都是默认 fallback，只有 rest 带 fallback。
    Router::new()
        .merge(index)
        .nest("/assets", assets)
        .merge(rest)
        // 压缩只挂在这个子路由上：`/api/*` 的 JSON / 32MB 二进制响应不该被压缩
        // （压 32MB octet-stream 既浪费 CPU，语义也不对）。
        .layer(CompressionLayer::new())
}

/// 按路径覆写 `Cache-Control`（`overriding`：即使上游已设也覆盖）。
fn cache(value: &'static str) -> SetResponseHeaderLayer<HeaderValue> {
    SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static(value))
}
