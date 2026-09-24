//! HTTP / WS 路由表。全局中间件在 `crate::build_router` 里叠加。

pub mod auth;
pub mod command;
pub mod events;
pub mod health;

use axum::routing::{get, post};
use axum::Router;

use crate::state::AppState;

/// 全部 API 路由（不含全局中间件）。
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(health::health))
        .route("/api/commands", get(command::list_commands))
        .route("/api/command", post(command::run_command))
        .route("/api/events", get(events::events))
        .route("/api/login", post(auth::login))
        .route("/api/logout", post(auth::logout))
        .route("/api/session", get(auth::session))
}
