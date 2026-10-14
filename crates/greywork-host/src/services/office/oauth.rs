//! 腾讯文档开放平台 OAuth 2.0：授权 URL 拼接 / 回调解析 / 换 token / 刷新。
//!
//! 端点（`authorize_url` / `token_url`）由 [`OAuthClientConfig`] 给出：真机走官方端点，
//! 测试把它指向本地 mock 服务端 —— 于是「请求长什么样、回包怎么映射」都能在无凭据下钉住。
//!
//! **`client_secret` 一律由调用方从环境变量取**（见 `OAuthAccessArgs::client_secret`），
//! 绝不进落盘 / 日志 / 渲染端。连请求失败的诊断也不带完整 URL —— 用 `Error::without_url`
//! 剥掉，否则 query 里的 `client_secret` 会顺着错误信息回渲染端。
//!
//! 本模块的**授权起点**原语（[`build_authorize_url`] / [`parse_callback`] / [`CallbackOutcome`] /
//! [`exchange_code`]）供下一批的 `office_oauth_begin/poll` 命令面调用，本批先把内核落全、
//! 暂未被生产代码引用，故整体放行 dead_code。
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::ERROR_BODY_CHARS;

/// 腾讯文档开放平台授权端点。
pub const DEFAULT_AUTHORIZE_URL: &str = "https://docs.qq.com/oauth/v2/authorize";
/// 腾讯文档开放平台换 / 刷 token 端点。
pub const DEFAULT_TOKEN_URL: &str = "https://docs.qq.com/oauth/v2/token";
/// 未显式指定 scope 时的缺省值。
const DEFAULT_SCOPE: &str = "all";
/// `expires_in` 缺失时的兜底有效期（秒）。正常都会回，这里只是不让缺字段变成「永不过期」。
const DEFAULT_EXPIRES_IN_SECS: i64 = 7200;

/// 当前毫秒时间戳。
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// OAuth 客户端配置。
#[derive(Debug, Clone)]
pub struct OAuthClientConfig {
    pub authorize_url: String,
    pub token_url: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub scope: Option<String>,
}

impl OAuthClientConfig {
    /// 用官方端点建一份配置；`scope` 缺省（由 [`build_authorize_url`] 落到 `all`）。
    pub fn new(client_id: impl Into<String>, redirect_uri: impl Into<String>) -> Self {
        Self {
            authorize_url: DEFAULT_AUTHORIZE_URL.to_string(),
            token_url: DEFAULT_TOKEN_URL.to_string(),
            client_id: client_id.into(),
            redirect_uri: redirect_uri.into(),
            scope: None,
        }
    }
}

/// 已授权的令牌集合（落盘即此形状）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSet {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// 绝对过期时刻（毫秒时间戳），由 `expires_in` 换算。
    pub expires_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}

/// 回调解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallbackOutcome {
    /// 用户同意授权，拿到一次性 code（5 分钟内有效）。
    Code { code: String, state: String },
    /// 用户拒绝 / 服务端返回错误。
    Denied {
        error: String,
        description: Option<String>,
    },
}

/* ===== 纯逻辑（无 I/O，便于单测） ===== */

/// 查询参数值编码（RFC 3986）：只放行 unreserved 字符，其余一律 `%XX`（空格 → `%20`）。
///
/// 不用 `form_urlencoded::byte_serialize`：那是**表单**编码，空格会变 `+`，而某些服务端在
/// query 里并不把 `+` 还原成空格（`state` 里若含 `+` 更会与原义混淆）。
fn encode_query(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let character = *byte as char;
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '~') {
            out.push(character);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 把 `key=value` 列表拼成查询串（值一律编码）。
fn encode_pairs(pairs: &[(&str, String)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", encode_query(key), encode_query(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// 把查询串挂到端点后面（端点已带 `?` 时用 `&` 续接）。
fn append_query(base: &str, query: &str) -> String {
    let base = base.trim();
    let separator = if base.contains('?') { '&' } else { '?' };
    format!("{base}{separator}{query}")
}

/// 拼授权 URL：用户用浏览器打开 → 微信 / QQ 扫码同意 → 跳回 `redirect_uri?code=..&state=..`。
pub fn build_authorize_url(cfg: &OAuthClientConfig, state: &str) -> String {
    let scope = cfg.scope.as_deref().unwrap_or(DEFAULT_SCOPE);
    let pairs = [
        ("client_id", cfg.client_id.clone()),
        ("redirect_uri", cfg.redirect_uri.clone()),
        ("new_login", "1".to_string()),
        ("response_type", "code".to_string()),
        ("scope", scope.to_string()),
        ("state", state.to_string()),
    ];
    append_query(&cfg.authorize_url, &encode_pairs(&pairs))
}

/// 解析回调：允许整条回调 URL，也允许只给查询串（用户从地址栏复制哪一段都认）。
pub fn parse_callback(raw: &str) -> Result<CallbackOutcome, String> {
    let trimmed = raw.trim();
    let query = trimmed
        .split_once('?')
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);

    let (mut code, mut state, mut error, mut description) = (None, None, None, None);
    for (key, value) in form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            "error_description" => description = Some(value.into_owned()),
            _ => {}
        }
    }

    if let Some(error) = error {
        return Ok(CallbackOutcome::Denied { error, description });
    }
    match code.filter(|value| !value.is_empty()) {
        Some(code) => Ok(CallbackOutcome::Code {
            code,
            state: state.unwrap_or_default(),
        }),
        None => Err(
            "回调地址里没有 code（授权被取消，或粘贴的不是回调 URL；请重新授权后复制完整回调地址）"
                .into(),
        ),
    }
}

/// 把 token 端点的 JSON 回包映射成 [`TokenSet`]（`now_ms` 注入便于单测）。
pub fn token_json_to_set(json: &Value, now_ms: i64, client_id: &str) -> Result<TokenSet, String> {
    let access_token = json
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "token 响应缺少 access_token：{}",
                crate::llm::truncate(&json.to_string(), ERROR_BODY_CHARS)
            )
        })?;
    let expires_in = expires_in_secs(json).unwrap_or(DEFAULT_EXPIRES_IN_SECS);
    Ok(TokenSet {
        access_token: access_token.to_string(),
        refresh_token: non_empty(json, "refresh_token"),
        expires_at: now_ms.saturating_add(expires_in.saturating_mul(1000)),
        scope: non_empty(json, "scope"),
        user_id: non_empty(json, "user_id"),
        client_id: non_empty(json, "client_id")
            .or_else(|| (!client_id.trim().is_empty()).then(|| client_id.trim().to_string())),
    })
}

/// 取字段并去空白；空串 / 缺字段一律当「没有」。数字（如 `user_id`）也收。
fn non_empty(json: &Value, key: &str) -> Option<String> {
    match json.get(key) {
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Some(Value::Number(number)) => Some(number.to_string()),
        _ => None,
    }
}

/// `expires_in` 可能是数字或字符串，都认。
fn expires_in_secs(json: &Value) -> Option<i64> {
    let value = json.get("expires_in")?;
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    if let Some(number) = value.as_f64() {
        return Some(number as i64);
    }
    value
        .as_str()
        .and_then(|text| text.trim().parse::<i64>().ok())
}

/// 令牌是否已过期。`skew_ms` 是提前量：留出刷新与请求在途的时间，避免「刚好过期」那一刻发出必败请求。
pub fn is_expired(set: &TokenSet, now_ms: i64, skew_ms: i64) -> bool {
    now_ms.saturating_add(skew_ms) >= set.expires_at
}

/* ===== 带 I/O（端点可指向本地 mock） ===== */

/// 用授权码换 token。
pub async fn exchange_code(
    cfg: &OAuthClientConfig,
    client_secret: &str,
    code: &str,
) -> Result<TokenSet, String> {
    let url = token_url(cfg, client_secret, "authorization_code", &[("code", code)]);
    fetch_token(cfg, &url).await
}

/// 用 refresh_token 换新 token。
pub async fn refresh(
    cfg: &OAuthClientConfig,
    client_secret: &str,
    refresh_token: &str,
) -> Result<TokenSet, String> {
    let url = token_url(
        cfg,
        client_secret,
        "refresh_token",
        &[("refresh_token", refresh_token)],
    );
    fetch_token(cfg, &url).await
}

/// 拼换 / 刷 token 的 GET 地址（腾讯文档要求凭据走 query）。
fn token_url(
    cfg: &OAuthClientConfig,
    client_secret: &str,
    grant_type: &str,
    extra: &[(&str, &str)],
) -> String {
    let mut pairs: Vec<(&str, String)> = vec![
        ("client_id", cfg.client_id.clone()),
        ("client_secret", client_secret.to_string()),
        ("redirect_uri", cfg.redirect_uri.clone()),
        ("grant_type", grant_type.to_string()),
    ];
    pairs.extend(
        extra
            .iter()
            .map(|(key, value)| (*key, (*value).to_string())),
    );
    append_query(&cfg.token_url, &encode_pairs(&pairs))
}

/// 发请求并解析成 [`TokenSet`]。
async fn fetch_token(cfg: &OAuthClientConfig, url: &str) -> Result<TokenSet, String> {
    let client = crate::http::shared_client(10)?;
    let response = client
        .get(url)
        .send()
        .await
        // `without_url`：错误里不能带完整 URL（query 里有 client_secret）。
        .map_err(|error| format!("请求 token 端点失败: {}", error.without_url()))?;
    let status = response.status();
    let text = crate::http::read_text(response, crate::http::RESPONSE_READ_TIMEOUT).await?;
    if !status.is_success() {
        return Err(format!(
            "token 端点返回 {status}：{}",
            crate::llm::truncate(&text, ERROR_BODY_CHARS)
        ));
    }
    let json: Value = serde_json::from_str(&text).map_err(|error| {
        format!(
            "token 响应不是 JSON: {error}（响应体：{}）",
            crate::llm::truncate(&text, ERROR_BODY_CHARS)
        )
    })?;
    token_json_to_set(&json, now_ms(), &cfg.client_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use serde_json::json;
    use std::sync::Arc;

    fn config() -> OAuthClientConfig {
        OAuthClientConfig::new("client-123", "https://app.example.com/oauth/callback")
    }

    #[test]
    fn build_authorize_url_encodes_all_params() {
        let url = build_authorize_url(&config(), "state-abc");
        assert!(url.starts_with(DEFAULT_AUTHORIZE_URL), "{url}");
        assert!(url.contains("client_id=client-123"), "{url}");
        assert!(url.contains("new_login=1"), "{url}");
        assert!(url.contains("response_type=code"), "{url}");
        assert!(url.contains("scope=all"), "缺省 scope=all：{url}");
        assert!(url.contains("state=state-abc"), "{url}");
        assert!(
            url.contains("redirect_uri=https%3A%2F%2Fapp.example.com%2Foauth%2Fcallback"),
            "回调地址要整体编码：{url}"
        );
    }

    #[test]
    fn build_authorize_url_encodes_chinese_and_spaces() {
        let mut cfg = config();
        cfg.scope = Some("文档 读写".into());
        let url = build_authorize_url(&cfg, "s");
        assert!(url.contains("%E6%96%87%E6%A1%A3"), "中文编码：{url}");
        assert!(url.contains("%20"), "空格编码为 %20：{url}");
        assert!(!url.contains(' '), "不应残留裸空格：{url}");
    }

    #[test]
    fn parse_callback_reads_code_and_state() {
        let outcome = parse_callback("code=abc&state=xyz&u=1").unwrap();
        assert_eq!(
            outcome,
            CallbackOutcome::Code {
                code: "abc".into(),
                state: "xyz".into()
            }
        );
    }

    #[test]
    fn parse_callback_accepts_full_url_and_leading_question() {
        let full = parse_callback("https://app.example.com/cb?code=c%2Bd&state=s").unwrap();
        assert_eq!(
            full,
            CallbackOutcome::Code {
                code: "c+d".into(),
                state: "s".into()
            },
            "%2B 要还原成 +"
        );
        let leading = parse_callback("?code=z&state=s").unwrap();
        assert_eq!(
            leading,
            CallbackOutcome::Code {
                code: "z".into(),
                state: "s".into()
            }
        );
    }

    #[test]
    fn parse_callback_reports_denied_and_missing_code() {
        let denied =
            parse_callback("error=access_denied&error_description=user%20refused").unwrap();
        assert_eq!(
            denied,
            CallbackOutcome::Denied {
                error: "access_denied".into(),
                description: Some("user refused".into())
            }
        );
        let error = parse_callback("state=only").unwrap_err();
        assert!(error.contains("code"), "缺 code 要指路：{error}");
    }

    #[test]
    fn token_json_maps_fields_and_converts_expiry() {
        let set = token_json_to_set(
            &json!({
                "access_token": "at",
                "refresh_token": "rt",
                "expires_in": 7200,
                "scope": "all",
                "token_type": "Bearer",
                "user_id": "u-9",
            }),
            1_000_000,
            "client-123",
        )
        .unwrap();
        assert_eq!(set.access_token, "at");
        assert_eq!(set.refresh_token.as_deref(), Some("rt"));
        assert_eq!(set.expires_at, 1_000_000 + 7_200_000);
        assert_eq!(set.scope.as_deref(), Some("all"));
        assert_eq!(set.user_id.as_deref(), Some("u-9"));
        assert_eq!(set.client_id.as_deref(), Some("client-123"));
    }

    #[test]
    fn token_json_accepts_string_expires_in_and_number_user_id() {
        let set = token_json_to_set(
            &json!({ "access_token": "at", "expires_in": "3600", "user_id": 42 }),
            0,
            "cid",
        )
        .unwrap();
        assert_eq!(set.expires_at, 3_600_000);
        assert_eq!(set.user_id.as_deref(), Some("42"));
        assert_eq!(set.refresh_token, None);
    }

    #[test]
    fn token_json_rejects_missing_access_token() {
        let error = token_json_to_set(&json!({ "error": "invalid_client" }), 0, "cid").unwrap_err();
        assert!(error.contains("access_token"), "{error}");
    }

    #[test]
    fn is_expired_honours_skew() {
        let set = TokenSet {
            access_token: "at".into(),
            refresh_token: None,
            expires_at: 10_000,
            scope: None,
            user_id: None,
            client_id: None,
        };
        assert!(!is_expired(&set, 9_000, 0));
        assert!(is_expired(&set, 10_000, 0), "到点即过期");
        assert!(is_expired(&set, 9_500, 500), "提前量内即视为过期");
        assert!(!is_expired(&set, 9_499, 500));
    }

    /// 起一个「收一个请求、记下来、回一段 JSON」的本地服务。
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

    #[tokio::test]
    async fn exchange_code_posts_grant_and_parses_token() {
        let (url, seen) = token_server(
            200,
            r#"{"access_token":"at","expires_in":3600,"refresh_token":"rt"}"#,
        )
        .await;
        let mut cfg = config();
        cfg.token_url = url;
        let set = exchange_code(&cfg, "secret-value", "the-code")
            .await
            .expect("ok");
        assert_eq!(set.access_token, "at");
        assert_eq!(set.refresh_token.as_deref(), Some("rt"));

        let request = seen.lock().clone();
        assert!(
            request.starts_with("GET /oauth/v2/token?"),
            "请求行：{request}"
        );
        assert!(
            request.contains("grant_type=authorization_code"),
            "{request}"
        );
        assert!(request.contains("code=the-code"), "{request}");
        assert!(request.contains("client_id=client-123"), "{request}");
        assert!(request.contains("client_secret=secret-value"), "{request}");
    }

    #[tokio::test]
    async fn refresh_posts_refresh_grant() {
        let (url, seen) = token_server(200, r#"{"access_token":"at2","expires_in":3600}"#).await;
        let mut cfg = config();
        cfg.token_url = url;
        let set = refresh(&cfg, "secret-value", "the-refresh")
            .await
            .expect("ok");
        assert_eq!(set.access_token, "at2");
        let request = seen.lock().clone();
        assert!(request.contains("grant_type=refresh_token"), "{request}");
        assert!(request.contains("refresh_token=the-refresh"), "{request}");
    }

    #[tokio::test]
    async fn fetch_token_reports_non_success_status() {
        let (url, _seen) = token_server(400, r#"{"error":"invalid_grant"}"#).await;
        let mut cfg = config();
        cfg.token_url = url;
        let error = exchange_code(&cfg, "s", "bad").await.unwrap_err();
        assert!(error.contains("400"), "{error}");
        assert!(error.contains("invalid_grant"), "{error}");
    }
}
