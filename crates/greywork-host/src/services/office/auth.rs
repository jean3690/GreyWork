//! 扫码授权的命令面逻辑：拼授权页地址 / 交回调换 token / 查状态 / 退出登录。
//!
//! **宿主无状态**（与 office 的其余部分一致，见 `app/commands/office.rs` 的域注释）：授权会话
//! 不存在宿主侧 —— `state` 由 [`oauth_begin`] 生成后交给渲染端保管，提交时随
//! [`OAuthSubmitArgs::expected_state`] 回传校验。这样既不必新增 host struct，也不必动
//! `Services` / `Channels` 的构造点，桌面端与服务端走的是同一条路。
//!
//! 回填方式是**粘贴回调 URL**：系统浏览器打开授权页 → 用户同意 → 浏览器停在
//! `redirect_uri?code=..&state=..` → 整条 URL 粘回来。[`oauth::parse_callback`] 认整条 URL，
//! 也认裸查询串，用户从地址栏复制哪一段都行。

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::oauth::{self, OAuthClientArgs};
use super::store;

/// `office_oauth_begin` 入参。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthBeginArgs {
    pub client: OAuthClientArgs,
}

/// `office_oauth_begin` 结果：把授权页地址与本次 state 交给渲染端。
///
/// `state` 必须由渲染端保管，提交时原样回传 —— 它是「这条回调确实出自本次授权」的唯一凭据。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthBeginResult {
    pub authorize_url: String,
    pub state: String,
}

/// `office_oauth_submit` 入参。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthSubmitArgs {
    pub client: OAuthClientArgs,
    /// 从浏览器地址栏复制回来的整条回调 URL（或裸查询串）。
    pub callback: String,
    /// [`OAuthBeginResult::state`] 的原样回传；缺省则跳过校验。
    #[serde(default)]
    pub expected_state: Option<String>,
}

/// `office_oauth_status` 入参。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStatusArgs {
    pub client_id: String,
}

/// `office_oauth_logout` 入参。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthLogoutArgs {
    pub client_id: String,
}

/// 授权状态。**绝不回 access_token / refresh_token** —— 渲染端只需要知道「有没有、还新不新」。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStatus {
    pub authorized: bool,
    /// 是否已过期。未授权恒为 false。
    ///
    /// 这里用**字面到期时刻**判定，不带刷新提前量：界面上的「已过期」若比实际早 5 分钟，
    /// 用户会以为令牌废了。刷新提前量只在 `store::resolve_access_token` 内部生效。
    pub expired: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
}

impl OAuthStatus {
    /// 未授权（查不到 / 已退出登录）。
    fn unauthorized() -> Self {
        Self {
            authorized: false,
            expired: false,
            expires_at: None,
            scope: None,
            user_id: None,
        }
    }

    /// 由已存令牌推导状态。
    fn from_token(set: &oauth::TokenSet) -> Self {
        Self {
            authorized: true,
            expired: oauth::is_expired(set, oauth::now_ms(), 0),
            expires_at: Some(set.expires_at),
            scope: set.scope.clone(),
            user_id: set.user_id.clone(),
        }
    }
}

/// 拼授权页地址 + 生成一次性 state。纯函数，不发网络请求。
pub fn oauth_begin(args: OAuthBeginArgs) -> Result<OAuthBeginResult, String> {
    let cfg = args.client.client_config();
    if cfg.client_id.is_empty() {
        return Err("缺少 clientId（开放平台应用的 client_id）".into());
    }
    if cfg.redirect_uri.is_empty() {
        return Err("缺少 redirectUri（须与开放平台登记的回调地址逐字一致）".into());
    }
    let state = random_state()?;
    Ok(OAuthBeginResult {
        authorize_url: oauth::build_authorize_url(&cfg, &state),
        state,
    })
}

/// 交回调换 token 并落盘。
///
/// 顺序有意如此：**先解析回调、再取密钥、最后才发请求** —— 用户点了「拒绝」时，
/// 报的是「授权被拒绝」而不是「没配 clientSecretEnv」。
pub async fn oauth_submit(data_dir: &Path, args: OAuthSubmitArgs) -> Result<OAuthStatus, String> {
    let cfg = args.client.client_config();

    let code = match oauth::parse_callback(&args.callback)? {
        oauth::CallbackOutcome::Code { code, state } => {
            let expected = args
                .expected_state
                .as_deref()
                .map(str::trim)
                .unwrap_or_default();
            if !expected.is_empty() && state != expected {
                return Err(
                    "回调里的 state 与本次授权不一致：可能粘贴了别的会话的回调地址，请重新授权"
                        .into(),
                );
            }
            code
        }
        oauth::CallbackOutcome::Denied { error, description } => {
            let detail = description
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty());
            return Err(match detail {
                Some(detail) => format!("授权被拒绝：{error}（{detail}）"),
                None => format!("授权被拒绝：{error}"),
            });
        }
    };

    let client_secret = args.client.client_secret()?;
    let set = oauth::exchange_code(&cfg, &client_secret, &code).await?;
    store::save(data_dir, &cfg.client_id, &set)?;
    Ok(OAuthStatus::from_token(&set))
}

/// 查某 client 的授权状态。查不到 = 未授权（不是错误）。
pub fn oauth_status(data_dir: &Path, args: OAuthStatusArgs) -> OAuthStatus {
    match store::load(data_dir, &args.client_id) {
        Some(set) => OAuthStatus::from_token(&set),
        None => OAuthStatus::unauthorized(),
    }
}

/// 退出登录：清掉该 client 的令牌。
pub fn oauth_logout(data_dir: &Path, args: OAuthLogoutArgs) -> Result<(), String> {
    store::clear(data_dir, &args.client_id)
}

/// 一次性 state：16 字节随机 → 32 位十六进制。
fn random_state() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| format!("随机数生成失败: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use std::path::PathBuf;
    use std::sync::Arc;

    const CLIENT: &str = "client-123";
    const SECRET_ENV: &str = "GREYWORK_TEST_OFFICE_OAUTH_SECRET";

    fn client() -> OAuthClientArgs {
        OAuthClientArgs {
            client_id: CLIENT.into(),
            client_secret_env: Some(SECRET_ENV.into()),
            authorize_url: None,
            token_url: None,
            redirect_uri: "https://app.example.com/oauth/callback".into(),
            scope: None,
        }
    }

    fn status_args() -> OAuthStatusArgs {
        OAuthStatusArgs {
            client_id: CLIENT.into(),
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gw-office-auth-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    fn token_set(expires_at: i64) -> oauth::TokenSet {
        oauth::TokenSet {
            access_token: "at".into(),
            refresh_token: Some("rt".into()),
            expires_at,
            scope: Some("all".into()),
            user_id: Some("u".into()),
            client_id: Some(CLIENT.into()),
        }
    }

    #[test]
    fn begin_builds_authorize_url_and_fresh_state() {
        let first = oauth_begin(OAuthBeginArgs { client: client() }).expect("begin");
        let second = oauth_begin(OAuthBeginArgs { client: client() }).expect("begin");

        assert!(
            first
                .authorize_url
                .starts_with(oauth::DEFAULT_AUTHORIZE_URL),
            "{}",
            first.authorize_url
        );
        assert!(
            first.authorize_url.contains("client_id=client-123"),
            "{}",
            first.authorize_url
        );
        assert!(
            first
                .authorize_url
                .contains(&format!("state={}", first.state)),
            "URL 里的 state 要与回给渲染端的一致：{}",
            first.authorize_url
        );
        assert_eq!(first.state.len(), 32, "16 字节 → 32 位十六进制");
        assert!(first.state.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first.state, second.state, "state 必须每次不同");
    }

    #[test]
    fn begin_rejects_missing_client_id_or_redirect() {
        let mut blank_id = client();
        blank_id.client_id = "  ".into();
        assert!(oauth_begin(OAuthBeginArgs { client: blank_id })
            .unwrap_err()
            .contains("clientId"));

        let mut blank_redirect = client();
        blank_redirect.redirect_uri = String::new();
        assert!(oauth_begin(OAuthBeginArgs {
            client: blank_redirect
        })
        .unwrap_err()
        .contains("redirectUri"));
    }

    #[tokio::test]
    async fn submit_exchanges_code_and_persists_token() {
        std::env::set_var(SECRET_ENV, "app-secret");
        let (url, seen) = token_server(
            200,
            r#"{"access_token":"at","expires_in":3600,"user_id":"u-1"}"#,
        )
        .await;
        let dir = temp_dir("submit");
        let mut with_endpoint = client();
        with_endpoint.token_url = Some(url);

        let status = oauth_submit(
            &dir,
            OAuthSubmitArgs {
                client: with_endpoint,
                callback: "https://app.example.com/oauth/callback?code=the-code&state=s1".into(),
                expected_state: Some("s1".into()),
            },
        )
        .await
        .expect("submit ok");

        assert!(status.authorized && !status.expired);
        assert_eq!(status.user_id.as_deref(), Some("u-1"));

        let request = seen.lock().clone();
        assert!(
            request.contains("grant_type=authorization_code"),
            "{request}"
        );
        assert!(request.contains("code=the-code"), "{request}");

        let stored = store::load(&dir, CLIENT).expect("token 要落盘");
        assert_eq!(stored.access_token, "at");
        assert!(
            oauth_status(&dir, status_args()).authorized,
            "落盘后 status 要能读回"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// state 不匹配在发请求**之前**就被拦下（`client()` 的 token_url 是官方端点，不能真的连出去）。
    #[tokio::test]
    async fn submit_rejects_state_mismatch() {
        let dir = temp_dir("state");
        let error = oauth_submit(
            &dir,
            OAuthSubmitArgs {
                client: client(),
                callback: "https://app.example.com/cb?code=c&state=someone-else".into(),
                expected_state: Some("mine".into()),
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("state"), "{error}");
        assert!(store::load(&dir, CLIENT).is_none(), "拒了就不该落盘");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 用户在授权页点了「拒绝」：报授权被拒，而不是「没配密钥」（密钥这一步还没走到）。
    #[tokio::test]
    async fn submit_reports_denied_callback_without_needing_secret() {
        let dir = temp_dir("denied");
        let mut without_secret = client();
        without_secret.client_secret_env = None;
        let error = oauth_submit(
            &dir,
            OAuthSubmitArgs {
                client: without_secret,
                callback:
                    "https://app.example.com/cb?error=access_denied&error_description=user%20said%20no"
                        .into(),
                expected_state: None,
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("access_denied"), "{error}");
        assert!(error.contains("user said no"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn submit_reports_missing_client_secret_env() {
        let dir = temp_dir("no-secret");
        let mut without_secret = client();
        without_secret.client_secret_env = None;
        let error = oauth_submit(
            &dir,
            OAuthSubmitArgs {
                client: without_secret,
                callback: "https://app.example.com/cb?code=c&state=s".into(),
                expected_state: None,
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("clientSecretEnv"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_round_trips_through_logout() {
        let dir = temp_dir("status");
        let before = oauth_status(&dir, status_args());
        assert!(!before.authorized && !before.expired && before.expires_at.is_none());

        store::save(&dir, CLIENT, &token_set(oauth::now_ms() + 3_600_000)).expect("save");
        let after = oauth_status(&dir, status_args());
        assert!(after.authorized && !after.expired);
        assert_eq!(after.scope.as_deref(), Some("all"));

        oauth_logout(
            &dir,
            OAuthLogoutArgs {
                client_id: CLIENT.into(),
            },
        )
        .expect("logout");
        assert!(
            !oauth_status(&dir, status_args()).authorized,
            "退出后应回未授权"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_flags_expired_token() {
        let dir = temp_dir("expired");
        store::save(&dir, CLIENT, &token_set(oauth::now_ms() - 1)).expect("save");
        let status = oauth_status(&dir, status_args());
        assert!(status.authorized, "过期不等于未授权");
        assert!(status.expired);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 起一个「收一个请求、记下来、回一段 token JSON」的本地端点。
    async fn token_server(status: u16, body: &'static str) -> (String, Arc<Mutex<String>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let seen = Arc::new(Mutex::new(String::new()));
        let writer = Arc::clone(&seen);
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buffer = vec![0u8; 8192];
                let read = stream.read(&mut buffer).await.unwrap_or(0);
                *writer.lock() = String::from_utf8_lossy(&buffer[..read]).to_string();
                let reason = if status == 200 { "OK" } else { "Bad Request" };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
                let _ = stream.shutdown().await;
            }
        });
        (format!("http://{addr}/oauth/v2/token"), seen)
    }
}
