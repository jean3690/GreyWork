//! 控制面（back/grey Java）客户端与云端自动化任务消费。
//!
//! 配置走环境变量：GREYWORK_CONTROL_URL + GREYWORK_CONTROL_TOKEN 必须同时给出
//! 才启用（见 [`ControlPlaneConfig::from_env`]）。worker 语义与
//! [`crate::services::host_exec`] 的本地兜底执行一致：LLM 直连单轮，
//! 无 ACP / 无工具 / 无权限请求面 —— 无人值守不存在权限裁决问题，
//! 绑定 ACP 后端的任务直接 finish failed，等应用内执行。
//!
//! 循环结构：心跳子循环（注册一次，此后每 tick 心跳，404/401 时重注册）
//! 以及主循环（认领 → 逐条执行 → 回执）。执行串行，避免打爆模型限流；
//! 长任务期间心跳由独立任务维持，宿主不会被控制面判离线。

use crate::core::host::HostContext;
use crate::db::Db;
use crate::infra::http::{read_json, read_text, shared_client, RESPONSE_READ_TIMEOUT};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// 心跳/认领 tick 间隔（秒）。
pub const TICK_SECS: u64 = 30;
/// 每 tick 最多认领数（串行执行，防打爆模型限流）。
pub const MAX_CLAIM_PER_TICK: u32 = 3;
/// 单条执行超时（秒）：默认 25min，给控制面 30min 认领租约留回收缓冲。
pub const DEFAULT_EXECUTION_TIMEOUT_SECS: u64 = 1_500;

/// 控制面接入配置。缺一即禁用（返回 None，worker 不启动）。
#[derive(Debug, Clone)]
pub struct ControlPlaneConfig {
    pub base_url: String,
    pub token: String,
    pub tick_secs: u64,
    pub execution_timeout_secs: u64,
}

impl ControlPlaneConfig {
    /// GREYWORK_CONTROL_URL / GREYWORK_CONTROL_TOKEN 必填；
    /// GREYWORK_CONTROL_TICK_SECS / GREYWORK_CONTROL_TIMEOUT_SECS 可选。
    pub fn from_env() -> Option<Self> {
        let env = |name: &str| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_string())
        };
        let base_url = env("GREYWORK_CONTROL_URL").filter(|value| !value.is_empty())?;
        let token = env("GREYWORK_CONTROL_TOKEN").filter(|value| !value.is_empty())?;
        let tick_secs = env("GREYWORK_CONTROL_TICK_SECS")
            .and_then(|value| value.parse().ok())
            .unwrap_or(TICK_SECS);
        let execution_timeout_secs = env("GREYWORK_CONTROL_TIMEOUT_SECS")
            .and_then(|value| value.parse().ok())
            .unwrap_or(DEFAULT_EXECUTION_TIMEOUT_SECS);
        Some(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            token,
            tick_secs: tick_secs.max(5),
            execution_timeout_secs: execution_timeout_secs.max(30),
        })
    }
}

/// 到期任务（控制面 DueView，camelCase）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlDue {
    pub id: i64,
    pub task_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub target: String,
    pub intent: String,
    #[serde(default)]
    pub acp_provider_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

/// 控制面 HTTP 客户端。所有方法失败都返回 String（含状态码），由调用方决定重试。
pub struct ControlPlaneClient {
    base_url: String,
    token: String,
}

impl ControlPlaneClient {
    pub fn new(base_url: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            token: token.into(),
        }
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        shared_client(10)
            .expect("http client build")
            .request(method, format!("{}{}", self.base_url, path))
            .bearer_auth(&self.token)
    }

    /// 宿主注册（按设备 upsert）。返回 ()——204/200 都算成功。
    pub async fn register(&self, name: &str, version: &str) -> Result<(), String> {
        let body = serde_json::json!({ "name": name, "version": version, "capabilities": [] });
        let response = self
            .request(reqwest::Method::PUT, "/api/hosts/me")
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("register 请求失败: {error}"))?;
        ensure_success(response, "register").await
    }

    pub async fn heartbeat(&self) -> Result<(), String> {
        let response = self
            .request(reqwest::Method::POST, "/api/hosts/me/heartbeat")
            .send()
            .await
            .map_err(|error| format!("heartbeat 请求失败: {error}"))?;
        ensure_success(response, "heartbeat").await
    }

    /// 认领到期任务。执行方认领即租约生效，须回执 finish 释放。
    pub async fn claim(&self, limit: u32) -> Result<Vec<ControlDue>, String> {
        let response = self
            .request(reqwest::Method::POST, "/api/hosts/me/automation/claim")
            .json(&serde_json::json!({ "limit": limit }))
            .send()
            .await
            .map_err(|error| format!("claim 请求失败: {error}"))?;
        read_json(response, RESPONSE_READ_TIMEOUT).await
    }

    /// 回执执行结果。status: ok / failed（与控制面 FinishRequest 对齐）。
    pub async fn finish(
        &self,
        due_id: i64,
        ok: bool,
        detail: &str,
        session_id: Option<&str>,
        output: Option<&str>,
    ) -> Result<(), String> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct FinishBody<'a> {
            status: &'a str,
            detail: &'a str,
            session_id: Option<&'a str>,
            output: Option<&'a str>,
        }
        let response = self
            .request(
                reqwest::Method::POST,
                &format!("/api/hosts/me/automation/due/{due_id}/finish"),
            )
            .json(&FinishBody {
                status: if ok { "ok" } else { "failed" },
                detail,
                session_id,
                output,
            })
            .send()
            .await
            .map_err(|error| format!("finish 请求失败: {error}"))?;
        ensure_success(response, "finish").await
    }
}

/// 非 2xx 统一转 String；401/404 给出可操作文案（token 失效 / 设备被删）。
async fn ensure_success(response: reqwest::Response, action: &str) -> Result<(), String> {
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let body = read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .unwrap_or_default();
    let hint = match status.as_u16() {
        401 => "（登录态失效，需重新入场/更新 GREYWORK_CONTROL_TOKEN）",
        404 => "（设备或任务不存在，可能已被吊销/回收）",
        _ => "",
    };
    Err(format!("{action} 失败: HTTP {status}{hint} {body}")
        .trim_end()
        .to_string())
}

/// 单条云端任务的执行结果（通知与日志用）。
pub struct ControlOutcome {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

/// 执行单条：与本地兜底同一套 LLM 直连路径；绑定 ACP 的任务拒绝执行。
/// 成功返回 (回复全文, 本地会话 id)——会话落本地库，应用内可查。
async fn execute_due(
    db: &Db,
    due: &ControlDue,
    timeout: Duration,
) -> Result<(String, String), String> {
    if due
        .acp_provider_id
        .as_deref()
        .is_some_and(|id| !id.is_empty())
    {
        return Err(
            "任务绑定 ACP 后端：宿主无人值守执行只支持本机模型直连，需在应用内执行".to_string(),
        );
    }
    let endpoint = crate::services::host_exec::resolve_default_llm(db)?;
    let future =
        crate::services::host_exec::chat_once(&endpoint, &due.intent, due.model.as_deref());
    let reply = tokio::time::timeout(timeout, future)
        .await
        .map_err(|_| format!("执行超时（{} 秒上限）", timeout.as_secs()))??;
    let conversation_id =
        crate::services::host_exec::record_host_conversation(db, &due.name, &due.intent, &reply)?;
    Ok((reply, conversation_id))
}

/// 单轮消费（注册 + 心跳 + 认领 + 逐条执行 + 回执）。测试入口也是它的复用点：
/// 真正的 worker 循环只是按 tick 反复调它（注册态另由心跳循环维持）。
pub async fn consume_tick(
    host: &dyn HostContext,
    db: &Db,
    client: &ControlPlaneClient,
    execution_timeout: Duration,
) -> Vec<ControlOutcome> {
    if let Err(error) = client
        .register("greywork-host", env!("CARGO_PKG_VERSION"))
        .await
    {
        crate::log::error("control-plane", format!("宿主注册失败，跳过本轮: {error}"));
        return Vec::new();
    }
    if let Err(error) = client.heartbeat().await {
        crate::log::error("control-plane", format!("心跳失败，跳过本轮: {error}"));
        return Vec::new();
    }
    claim_round(host, db, client, execution_timeout).await
}

/// 认领 → 逐条串行执行 → 回执。consume_tick 与 worker 主循环共用。
async fn claim_round(
    host: &dyn HostContext,
    db: &Db,
    client: &ControlPlaneClient,
    execution_timeout: Duration,
) -> Vec<ControlOutcome> {
    let dues = match client.claim(MAX_CLAIM_PER_TICK).await {
        Ok(dues) => dues,
        Err(error) => {
            crate::log::error("control-plane", format!("认领到期任务失败: {error}"));
            return Vec::new();
        }
    };
    let mut outcomes = Vec::with_capacity(dues.len());
    for due in dues {
        let result = execute_due(db, &due, execution_timeout).await;
        let (ok, detail, session_id, output) = match &result {
            Ok((reply, conversation_id)) => (
                true,
                crate::services::host_exec::preview(reply),
                Some(conversation_id.clone()),
                Some(reply.clone()),
            ),
            Err(error) => (false, error.clone(), None, None),
        };
        if let Err(error) = client
            .finish(
                due.id,
                ok,
                &detail,
                session_id.as_deref(),
                output.as_deref(),
            )
            .await
        {
            crate::log::error(
                "control-plane",
                format!("回执失败 due={} task={}: {error}", due.id, due.task_id),
            );
        }
        crate::log::info(
            "control-plane",
            format!(
                "云端任务{}: {} ({}) — {detail}",
                if ok { "执行完成" } else { "执行失败" },
                due.name,
                due.task_id
            ),
        );
        host.notify("自动化任务", &format!("{}：{}", due.name, detail));
        outcomes.push(ControlOutcome {
            name: due.name.clone(),
            ok,
            detail,
        });
    }
    outcomes
}

/// 云端任务消费主循环（**无限循环，由宿主自行 spawn**，同 scheduler::run_ticker 约定）。
///
/// 心跳独立成任务：执行串行且可能长达分钟级，主循环阻塞期间宿主在线标记
/// 由心跳维持，不会被控制面判离线。注册失败按 tick 重试（首次启动时控制面
/// 可能尚未部署完）。
pub async fn run_control_plane_worker(
    host: Arc<dyn HostContext>,
    db: Arc<Db>,
    config: ControlPlaneConfig,
) {
    let client = Arc::new(ControlPlaneClient::new(
        config.base_url.clone(),
        config.token.clone(),
    ));
    let execution_timeout = Duration::from_secs(config.execution_timeout_secs);
    crate::log::info(
        "control-plane",
        format!(
            "控制面任务消费已启动: {}（tick {}s）",
            config.base_url, config.tick_secs
        ),
    );

    let registered = Arc::new(AtomicBool::new(false));
    // 心跳循环：未注册时先注册，注册后周期心跳；404/401 等失败回退重注册。
    {
        let client = Arc::clone(&client);
        let registered = Arc::clone(&registered);
        let tick = Duration::from_secs(config.tick_secs);
        tokio::spawn(async move {
            loop {
                if registered.load(Ordering::Relaxed) {
                    match client.heartbeat().await {
                        Ok(()) => {}
                        Err(error) => {
                            crate::log::error(
                                "control-plane",
                                format!("心跳失败，将重注册: {error}"),
                            );
                            registered.store(false, Ordering::Relaxed);
                        }
                    }
                } else {
                    match client
                        .register("greywork-host", env!("CARGO_PKG_VERSION"))
                        .await
                    {
                        Ok(()) => {
                            registered.store(true, Ordering::Relaxed);
                            crate::log::info("control-plane", "宿主注册成功");
                        }
                        Err(error) => {
                            crate::log::error("control-plane", format!("宿主注册失败: {error}"));
                        }
                    }
                }
                tokio::time::sleep(tick).await;
            }
        });
    }

    let tick = Duration::from_secs(config.tick_secs);
    loop {
        claim_round(host.as_ref(), &db, &client, execution_timeout).await;
        tokio::time::sleep(tick).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::host::{HostContext, HostPaths};
    use serde_json::Value;
    use std::collections::HashMap;
    use std::sync::Mutex;

    struct MockHost {
        notifications: Mutex<Vec<String>>,
    }

    impl MockHost {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                notifications: Mutex::new(Vec::new()),
            })
        }
    }

    impl HostContext for MockHost {
        fn paths(&self) -> &HostPaths {
            static PATHS: std::sync::OnceLock<HostPaths> = std::sync::OnceLock::new();
            PATHS.get_or_init(|| HostPaths::new("/tmp", "/tmp/greywork-test"))
        }

        fn emit(&self, _event: &str, _payload: Value) {}

        fn notify(&self, title: &str, body: &str) {
            self.notifications
                .lock()
                .expect("notifications")
                .push(format!("{title}:{body}"));
        }
    }

    /// 本地假控制面：按路径精确/前缀匹配返回预设响应，并记录收到的请求。
    /// 返回 (基址, 请求记录)。记录条目形如 "POST /path {body}"，head 含鉴权头。
    async fn spawn_fake_cp(
        routes: Vec<(String, u16, String)>,
    ) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let routes: HashMap<String, (u16, String)> = routes
            .into_iter()
            .map(|(path, status, body)| (path, (status, body)))
            .collect();
        let seen_loop = Arc::clone(&seen);
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let routes = routes.clone();
                let seen = Arc::clone(&seen_loop);
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 65536];
                    let mut n = stream.read(&mut buf).await.unwrap_or(0);
                    // 读满请求体再回响应：只读一段就 shutdown，客户端请求若分
                    // 段到达会吃 RST，表现为 reqwest "error decoding response body"。
                    let head_end = buf[..n]
                        .windows(4)
                        .position(|window| {
                            window
                                == b"

"
                        })
                        .map(|index| index + 4);
                    if let Some(head_end) = head_end {
                        let content_length = String::from_utf8_lossy(&buf[..head_end])
                            .lines()
                            .find(|line| line.to_ascii_lowercase().starts_with("content-length"))
                            .and_then(|line| line.split(':').nth(1))
                            .and_then(|value| value.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        let total = head_end + content_length;
                        while n < total {
                            let read = stream.read(&mut buf[n..]).await.unwrap_or(0);
                            if read == 0 {
                                break;
                            }
                            n += read;
                        }
                    }
                    let raw = String::from_utf8_lossy(&buf[..n]).to_string();
                    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw.as_str(), ""));
                    let request_line = head.lines().next().unwrap_or("");
                    let mut segments = request_line.split(' ');
                    let method = segments.next().unwrap_or("");
                    let path = segments.next().unwrap_or("");
                    let auth = head
                        .lines()
                        .find(|line| line.to_ascii_lowercase().starts_with("authorization"))
                        .unwrap_or("")
                        .to_string();
                    seen.lock()
                        .expect("seen")
                        .push(format!("{method} {path} auth={auth:?} body={body}"));
                    let path_only = path.split('?').next().unwrap_or(path);
                    let route = routes
                        .iter()
                        .find(|(pattern, _)| path_only == *pattern)
                        .or_else(|| {
                            routes
                                .iter()
                                .find(|(pattern, _)| path_only.starts_with(*pattern))
                        });
                    let (status, resp_body) = route
                        .map(|(_, (status, body))| (*status, body.clone()))
                        .unwrap_or((404, "{}".to_string()));
                    let wire = format!(
                        "HTTP/1.1 {status} T\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{resp_body}",
                        resp_body.len()
                    );
                    let _ = stream.write_all(wire.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        (format!("http://{addr}"), seen)
    }

    fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!(
            "grey-cp-test-{}-{}.db",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        Db::open_at(&path).expect("open db")
    }

    #[tokio::test]
    async fn register_and_heartbeat_send_bearer_and_body() {
        let (url, seen) = spawn_fake_cp(vec![
            ("/api/hosts/me/heartbeat".to_string(), 204, "".to_string()),
            (
                "/api/hosts/me".to_string(),
                200,
                "{\"deviceId\":1,\"alive\":true}".to_string(),
            ),
        ])
        .await;
        let client = ControlPlaneClient::new(url, "tok-1");
        client
            .register("greywork-host", "9.9.9")
            .await
            .expect("register");
        client.heartbeat().await.expect("heartbeat");

        let records = seen.lock().expect("seen").clone();
        assert!(
            records.iter().any(|entry| {
                entry.starts_with("PUT /api/hosts/me ")
                    && entry.contains("Bearer tok-1")
                    && entry.contains("\"name\":\"greywork-host\"")
            }),
            "注册请求缺失或形状不对: {records:?}"
        );
        assert!(
            records
                .iter()
                .any(|entry| entry.starts_with("POST /api/hosts/me/heartbeat ")),
            "心跳请求缺失: {records:?}"
        );
    }

    #[tokio::test]
    async fn claim_parses_due_view() {
        let body = concat!(
            "[{\"id\":7,\"taskId\":\"at-1\",\"name\":\"日报\",\"target\":\"\",",
            "\"intent\":\"写日报\",\"acpProviderId\":null,\"model\":\"gpt-x\",\"dueAt\":\"2026-10-27T10:00:00\"}]"
        );
        let (url, _) = spawn_fake_cp(vec![(
            "/api/hosts/me/automation/claim".to_string(),
            200,
            body.to_string(),
        )])
        .await;
        let client = ControlPlaneClient::new(url.clone(), "t");
        let dues = client.claim(3).await.expect("claim");
        assert_eq!(dues.len(), 1);
        assert_eq!(dues[0].id, 7);
        assert_eq!(dues[0].task_id, "at-1");
        assert_eq!(dues[0].intent, "写日报");
        assert_eq!(dues[0].model.as_deref(), Some("gpt-x"));
        assert!(dues[0].acp_provider_id.is_none());
    }

    #[tokio::test]
    async fn consume_tick_refuses_acp_bound_due_and_finishes_failed() {
        let due_body = concat!(
            "[{\"id\":9,\"taskId\":\"at-2\",\"name\":\"绑定任务\",\"target\":\"\",",
            "\"intent\":\"跑后端\",\"acpProviderId\":\"claude-code\",\"model\":null,\"dueAt\":null}]"
        );
        let (url, seen) = spawn_fake_cp(vec![
            ("/api/hosts/me/heartbeat".to_string(), 204, "".to_string()),
            ("/api/hosts/me".to_string(), 200, "{}".to_string()),
            (
                "/api/hosts/me/automation/claim".to_string(),
                200,
                due_body.to_string(),
            ),
            (
                "/api/hosts/me/automation/due/".to_string(),
                204,
                "".to_string(),
            ),
        ])
        .await;
        let db = temp_db();
        let host = MockHost::new();
        let client = ControlPlaneClient::new(url, "t");

        let outcomes = consume_tick(host.as_ref(), &db, &client, Duration::from_secs(5)).await;

        assert_eq!(outcomes.len(), 1);
        assert!(!outcomes[0].ok);
        assert!(
            outcomes[0].detail.contains("ACP"),
            "拒绝文案: {}",
            outcomes[0].detail
        );
        assert!(
            host.notifications
                .lock()
                .expect("notifications")
                .iter()
                .any(|entry| entry.contains("绑定任务")),
            "应有系统通知"
        );
        let records = seen.lock().expect("seen").clone();
        assert!(
            records.iter().any(|entry| entry
                .starts_with("POST /api/hosts/me/automation/due/9/finish ")
                && entry.contains("\"status\":\"failed\"")
                && entry.contains("ACP")),
            "回执应为 failed 且带拒绝文案: {records:?}"
        );
    }

    #[tokio::test]
    async fn consume_tick_runs_llm_and_finishes_ok() {
        // 假 LLM：默认配置指向它
        let (llm_url, llm_seen) = spawn_fake_cp(vec![(
            "/v1/chat/completions".to_string(),
            200,
            "{\"choices\":[{\"message\":{\"content\":\"云端回复内容\"}}]}".to_string(),
        )])
        .await;
        let due_body = concat!(
            "[{\"id\":11,\"taskId\":\"at-3\",\"name\":\"模型任务\",\"target\":\"\",",
            "\"intent\":\"总结今天\",\"acpProviderId\":null,\"model\":\"m2\",\"dueAt\":null}]"
        );
        let (url, seen) = spawn_fake_cp(vec![
            ("/api/hosts/me/heartbeat".to_string(), 204, "".to_string()),
            ("/api/hosts/me".to_string(), 200, "{}".to_string()),
            (
                "/api/hosts/me/automation/claim".to_string(),
                200,
                due_body.to_string(),
            ),
            (
                "/api/hosts/me/automation/due/".to_string(),
                204,
                "".to_string(),
            ),
        ])
        .await;
        let db = temp_db();
        db.sync_settings(&serde_json::json!({
            "selectedModelProviderId": "x",
            "modelProviders": [{
                "id": "x", "baseUrl": llm_url, "model": "m1", "apiKeyEnv": "", "enabled": true
            }]
        }))
        .expect("settings");
        let host = MockHost::new();
        let client = ControlPlaneClient::new(url, "t");

        let outcomes = consume_tick(host.as_ref(), &db, &client, Duration::from_secs(10)).await;

        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].ok, "应执行成功: {}", outcomes[0].detail);
        let records = seen.lock().expect("seen").clone();
        let finish = records
            .iter()
            .find(|entry| entry.contains("/finish"))
            .expect("finish 请求");
        assert!(
            finish.contains("\"status\":\"ok\""),
            "回执应为 ok: {finish}"
        );
        assert!(finish.contains("云端回复内容"), "output 应带全文: {finish}");
        // 模型覆盖生效：LLM 请求体里的 model 是任务指定的 m2 而不是默认 m1
        let llm_records = llm_seen.lock().expect("llm seen").clone();
        let llm_call = llm_records
            .iter()
            .find(|entry| entry.contains("/chat/completions"))
            .expect("LLM 调用");
        assert!(
            llm_call.contains("\"model\":\"m2\""),
            "应使用任务模型: {llm_call}"
        );
    }

    #[tokio::test]
    async fn execute_timeout_finishes_failed() {
        // 挂死 LLM：accept 后不响应
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let llm_url = format!("http://{}", listener.local_addr().expect("addr"));
        tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.expect("accept");
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let due_body = concat!(
            "[{\"id\":12,\"taskId\":\"at-4\",\"name\":\"慢任务\",\"target\":\"\",",
            "\"intent\":\"长任务\",\"acpProviderId\":null,\"model\":null,\"dueAt\":null}]"
        );
        let (url, seen) = spawn_fake_cp(vec![
            ("/api/hosts/me/heartbeat".to_string(), 204, "".to_string()),
            ("/api/hosts/me".to_string(), 200, "{}".to_string()),
            (
                "/api/hosts/me/automation/claim".to_string(),
                200,
                due_body.to_string(),
            ),
            (
                "/api/hosts/me/automation/due/".to_string(),
                204,
                "".to_string(),
            ),
        ])
        .await;
        let db = temp_db();
        db.sync_settings(&serde_json::json!({
            "selectedModelProviderId": "x",
            "modelProviders": [{
                "id": "x", "baseUrl": llm_url, "model": "m1", "apiKeyEnv": "", "enabled": true
            }]
        }))
        .expect("settings");
        let host = MockHost::new();
        let client = ControlPlaneClient::new(url, "t");

        let outcomes = consume_tick(host.as_ref(), &db, &client, Duration::from_millis(300)).await;

        assert_eq!(outcomes.len(), 1);
        assert!(!outcomes[0].ok);
        assert!(
            outcomes[0].detail.contains("超时"),
            "应为超时文案: {}",
            outcomes[0].detail
        );
        let records = seen.lock().expect("seen").clone();
        assert!(
            records
                .iter()
                .any(|entry| entry.contains("/finish") && entry.contains("\"status\":\"failed\"")),
            "超时应回执 failed: {records:?}"
        );
    }
}
