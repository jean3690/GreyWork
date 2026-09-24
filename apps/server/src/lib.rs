//! GreyWork headless 服务端：单用户自托管的 Web 宿主。
//!
//! 复用 `crates/greywork-host` 的全部领域逻辑（命令面唯一真源是
//! `greywork_host::commands`），本 crate 只补三样宿主能力：
//! - **传输**：HTTP 命令端点 + WebSocket 事件总线（[`ServerHost`] 把事件推上广播通道）；
//! - **内置登录**：密码 → 会话 cookie / Bearer；
//! - **安全策略**：冻结 agent 白名单、拒绝 `db_agents_sync`、夹紧 sandbox/tier、
//!   预置授权根（见 [`policy`] 与 [`config`]）。
//!
//! 与桌面壳对称：桌面用 Tauri IPC + `TauriHost`，服务端用 HTTP/WS + [`ServerHost`]，
//! 两侧共用同一份 `dispatch`。前端的三态运行时适配在后续阶段（Stage 4）。

pub mod auth;
pub mod config;
pub mod error;
pub mod host;
pub mod middleware;
pub mod policy;
pub mod routes;
pub mod state;

use std::net::SocketAddr;
use std::sync::Arc;

use greywork_host::commands::CommandContext;
use greywork_host::host::{HostContext, HostPaths};

pub use config::ServerConfig;
pub use host::{EventBus, ServerEvent, ServerHost};
pub use state::AppState;

/// 请求体上限：`store_sessions_sync` / `fs_write_binary`（base64 附件）会远超 axum 默认 2MB。
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

/// 事件总线容量（每订阅者的环形缓冲长度）。
const EVENT_BUS_CAPACITY: usize = 1024;

/// 组装路由（含全局中间件：安全响应头 + Origin 校验 + 体积上限）。
///
/// 静态子路由（`GREYWORK_STATIC_DIR` 配好时）在 merge 后、全局 layer 前，
/// 于是它享受全部全局策略（体积上限对 GET 无害；`origin_guard` 跳过 GET/HEAD）。
pub fn build_router(state: AppState) -> axum::Router {
    use axum::extract::DefaultBodyLimit;
    use axum::middleware as mw;

    // `routes::router()` 必须保持默认 fallback：`merge` 只在一侧有自定义 fallback
    // 时才合法，静态子路由那边带着 `ServeDir` fallback。
    let mut app = routes::router();
    if let Some(dir) = state.config.static_dir.as_deref() {
        app = app.merge(routes::static_site::router(dir));
    }
    let origin_state = state.clone();
    app.layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(mw::from_fn_with_state(
            origin_state,
            middleware::origin_guard,
        ))
        .layer(mw::from_fn(middleware::security_headers))
        .with_state(state)
}

/// 启动服务：读配置 → 装配状态 → serve。
pub async fn run() -> Result<(), String> {
    let config = ServerConfig::load()?;
    std::fs::create_dir_all(&config.data_dir)
        .map_err(|error| format!("创建数据目录 {} 失败: {error}", config.data_dir.display()))?;

    // 配了静态托管就当场验有效：缺 index.html 必须启动硬失败，而不是
    // 「容器 healthy 但 UI 404」地悄悄带病运行（HEALTHCHECK 只打 /api/health）。
    let static_dir = config::resolve_static_dir(&config)?;

    let home = match &config.home_dir {
        Some(home) => home.clone(),
        None => config::resolve_home()?,
    };

    // 日志最先 init —— 其后每一步都可能写日志。
    greywork_host::log::init(config.data_dir.join("logs"));
    if let Some(dir) = &static_dir {
        greywork_host::log::info("server", format!("静态托管: {}", dir.display()));
    } else {
        greywork_host::log::info("server", "静态托管: 关闭（仅 /api）");
    }
    // 补一次登录 shell PATH 解析（容器里通常失败即回退继承的 PATH，无副作用）。
    greywork_host::process_guard::init_login_path();

    // 授权面：默认根 + 配置预置根。headless 没有原生选择器，运行期不能新增根。
    let default_root = greywork_host::store_fs::default_root(&home)?;
    let access = greywork_host::workspace_fs::WorkspaceFsAccess::new(
        &default_root,
        config.data_dir.join("workspace-path-access.json"),
    )?;
    for root in &config.workspace_roots {
        let canonical = access.authorize_selected_path(root)?;
        greywork_host::log::info("server", format!("预置授权根: {}", canonical.display()));
    }

    let bus = EventBus::new(EVENT_BUS_CAPACITY);
    let host: Arc<dyn HostContext> = Arc::new(ServerHost::new(
        HostPaths::new(&home, &config.data_dir),
        bus.clone(),
    ));

    let db = Arc::new(greywork_host::db::Db::open_at(
        &config.data_dir.join("greywork.db"),
    )?);

    let resolved = config::resolve_password(&config)?;
    if let Some(plaintext) = &resolved.generated_plaintext {
        eprintln!("{}", generated_password_banner(plaintext));
    }
    let sessions = Arc::new(auth::SessionStore::new(
        &resolved.hash,
        config.session_ttl(),
    )?);

    // 调度器：宿主兜底执行（浏览器不在场时自动化仍能跑）。本函数在 tokio runtime 里，
    // 可直接 `tokio::spawn`（桌面壳的 setup 不在 runtime 里，故那边用 tauri 的 spawn）。
    let ticker_host = Arc::clone(&host);
    let ticker_db = config.data_dir.join("greywork.db");
    tokio::spawn(async move { greywork_host::scheduler::run_ticker(ticker_host, ticker_db).await });

    let ctx = Arc::new(CommandContext {
        host: Arc::clone(&host),
        db,
        workspace: Arc::new(access),
        acp: Arc::new(greywork_host::acp_host::AcpHost::default()),
        llm: Arc::new(greywork_host::llm::LlmHost::default()),
        wechat: Arc::new(greywork_host::wechat::WechatHost::default()),
        dingtalk: Arc::new(greywork_host::dingtalk::DingTalkHost::default()),
        feishu: Arc::new(greywork_host::feishu::FeishuHost::default()),
        telegram: Arc::new(greywork_host::telegram::TelegramHost::default()),
        discord: Arc::new(greywork_host::discord::DiscordHost::default()),
        qq: Arc::new(greywork_host::qq::QqHost::default()),
        wecom: Arc::new(greywork_host::wecom::WecomHost::default()),
        // 冻结白名单：来自配置，不读 DB（DB 可被客户端改写，是 RCE 面）。
        agent_programs: Arc::new(config.agent_programs.clone()),
    });

    let state = AppState {
        ctx,
        bus,
        sessions,
        throttle: Arc::new(auth::LoginThrottle::default()),
        config: Arc::new(config.clone()),
    };

    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind(&config.bind)
        .await
        .map_err(|error| format!("绑定 {} 失败: {error}", config.bind))?;
    greywork_host::log::info("server", format!("greywork-server 监听 {}", config.bind));

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .map_err(|error| format!("服务运行失败: {error}"))?;

    Ok(())
}

/// 首次启动自动生成密码时的醒目提示（只打印一次）。
fn generated_password_banner(plaintext: &str) -> String {
    format!(
        "\n============================================================\n\
         首次启动：已生成随机登录密码（**只显示这一次**）\n\n    {plaintext}\n\n\
         已写入 <data_dir>/auth.json（0600）。请立即记录；\n\
         之后可用 `greywork-server set-password` 修改。\n\
         ============================================================"
    )
}

/// 优雅退出：Ctrl-C 或（unix）SIGTERM —— 容器 stop 发的是 SIGTERM，必须处理。
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
    greywork_host::log::info("server", "收到退出信号，正在关闭");
}
