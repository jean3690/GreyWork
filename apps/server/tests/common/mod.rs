//! 集成测试共享的装配与请求工具。
//!
//! `tests/common/` 不是测试目标（只有顶层 `tests/*.rs` 是），两个测试二进制各自
//! `mod common;` 引入。`allow(dead_code)`：两个二进制用到的子集不同，未用到的工具
//! 不该报错。

#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{header, HeaderValue, Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use greywork_host::commands::CommandContext;
use greywork_host::host::{HostContext, HostPaths};
use greywork_server::auth::{LoginThrottle, SessionStore};
use greywork_server::config::{hash_password, ServerConfig};
use greywork_server::host::{EventBus, ServerHost};
use greywork_server::state::AppState;

pub const PASSWORD: &str = "hunter2";

pub struct Harness {
    pub tmp: PathBuf,
    pub router: Router,
    pub state: AppState,
}

impl Harness {
    /// 默认（已授权）工作区根。
    pub fn root(&self) -> PathBuf {
        self.tmp.join("root")
    }
}

pub fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gw-server-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub fn harness(tag: &str) -> Harness {
    harness_with(tag, |_, _| {})
}

/// `configure(config, tmp)` 在状态构造前改配置；`tmp` 可用于创建预置根等目录。
pub fn harness_with(tag: &str, configure: impl FnOnce(&mut ServerConfig, &Path)) -> Harness {
    let tmp = temp_dir(tag);
    let mut config = ServerConfig {
        data_dir: tmp.join("data"),
        ..ServerConfig::default()
    };
    configure(&mut config, &tmp);

    let state = make_state(&tmp, config);
    // oneshot 下没有真实连接信息，注入回环地址让 `ConnectInfo` 可用（登录限流路径）。
    let router = greywork_server::build_router(state.clone())
        .layer(MockConnectInfo(SocketAddr::from(([127, 0, 0, 1], 12345))));
    Harness { tmp, router, state }
}

fn make_state(tmp: &Path, config: ServerConfig) -> AppState {
    let data_dir = tmp.join("data");
    let root = tmp.join("root");
    std::fs::create_dir_all(&data_dir).unwrap();
    std::fs::create_dir_all(&root).unwrap();

    let bus = EventBus::new(64);
    let host: Arc<dyn HostContext> = Arc::new(ServerHost::new(
        HostPaths::new(tmp.join("home"), data_dir.clone()),
        bus.clone(),
    ));
    let access =
        greywork_host::workspace_fs::WorkspaceFsAccess::new(&root, data_dir.join("access.json"))
            .unwrap();
    for extra in &config.workspace_roots {
        access.authorize_selected_path(extra).unwrap();
    }
    let db = Arc::new(greywork_host::db::Db::open_in_memory().unwrap());
    let ctx = Arc::new(CommandContext {
        host,
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
        agent_programs: Arc::new(config.agent_programs.clone()),
        frame_origins: Arc::new(config.frame_origins.clone()),
    });
    let sessions = Arc::new(
        SessionStore::new(&hash_password(PASSWORD).unwrap(), Duration::from_secs(3600)).unwrap(),
    );
    AppState {
        ctx,
        bus,
        sessions,
        throttle: Arc::new(LoginThrottle::default()),
        config: Arc::new(config),
    }
}

/* ===== 请求工具 ===== */

pub async fn send(
    router: &Router,
    request: Request<Body>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    (status, headers, body)
}

pub fn get(uri: &str) -> Request<Body> {
    Request::builder()
        .method(Method::GET)
        .uri(uri)
        .body(Body::empty())
        .unwrap()
}

pub fn post_json(uri: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

pub fn command_req(name: &str, args: Value) -> Request<Body> {
    post_json("/api/command", json!({ "command": name, "args": args }))
}

pub fn with_cookie(mut request: Request<Body>, token: &str) -> Request<Body> {
    request.headers_mut().insert(
        header::COOKIE,
        HeaderValue::from_str(&format!("gw_session={token}")).unwrap(),
    );
    request
}

pub fn with_bearer(mut request: Request<Body>, token: &str) -> Request<Body> {
    request.headers_mut().insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    request
}

pub async fn login(router: &Router, password: &str) -> String {
    let (status, _, body) = send(
        router,
        post_json("/api/login", json!({ "password": password })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "登录应成功: {}",
        String::from_utf8_lossy(&body)
    );
    serde_json::from_slice::<Value>(&body).unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string()
}

pub fn json_body(body: &[u8]) -> Value {
    serde_json::from_slice(body).unwrap_or_else(|error| {
        panic!(
            "响应不是 JSON: {error}; 原文={}",
            String::from_utf8_lossy(body)
        )
    })
}

/// 在随机端口上真实 serve（WS 升级无法 oneshot），返回绑定地址。
pub async fn serve(router: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    addr
}
