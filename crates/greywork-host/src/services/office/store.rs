//! OAuth 令牌落盘 + 凭证解析。
//!
//! 位置：`<app_data>/office/credentials.json`，形状是 `{ "<clientId>": TokenSet }` ——
//! **按 client_id 分键**，多个 OAuth 服务商（腾讯文档 / Microsoft 365 …）各存各的，互不覆盖。
//!
//! Unix 下收紧到 0600；Windows 靠 `app_data_dir()`（`%APPDATA%\<identifier>`）继承的 profile
//! ACL，与 `channels/common.rs` 同一套威胁模型。
//!
//! 备注：`channels/common.rs::write_private` 是同形的现成实现，但 `channels` 层高于 `services`，
//! 按分层守卫（`tests/layering.rs`）不能引用。日后把它上提到 `core`/`infra` 时，这里可换成共用实现。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::oauth::{self, OAuthClientConfig, TokenSet};

/// 应用数据目录下的子目录名。
const DIR_NAME: &str = "office";
/// 令牌文件名。
const CREDENTIALS_FILE: &str = "credentials.json";
/// 提前多久视为「需要刷新」——留出刷新与请求在途的时间。
const REFRESH_SKEW_MS: i64 = 5 * 60 * 1000;

/// 令牌库：client_id → 令牌。
///
/// 用 `BTreeMap` 而非 `HashMap`：落盘顺序稳定，diff 友好，测试也能直接读文件断言。
type Store = BTreeMap<String, TokenSet>;

/// 令牌文件路径。
fn credentials_path(data_dir: &Path) -> PathBuf {
    data_dir.join(DIR_NAME).join(CREDENTIALS_FILE)
}

/// 读整份令牌库；缺失 / 损坏 / 形状不符一律当「空」（调用方据此提示重新授权）。
fn read_store(data_dir: &Path) -> Store {
    let Ok(raw) = crate::text::read_bytes_without_bom(&credentials_path(data_dir)) else {
        return Store::new();
    };
    serde_json::from_slice(&raw).unwrap_or_default()
}

/// 写整份令牌库（Unix 0600）。
fn write_store(data_dir: &Path, store: &Store) -> Result<(), String> {
    let path = credentials_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建 {} 失败: {error}", parent.display()))?;
    }
    let json =
        serde_json::to_vec_pretty(store).map_err(|error| format!("序列化令牌失败: {error}"))?;
    write_private(&path, &json)
}

/// 读某个 client 的令牌；没有 → `None`。
pub fn load(data_dir: &Path, client_id: &str) -> Option<TokenSet> {
    read_store(data_dir).remove(client_id.trim())
}

/// 写某个 client 的令牌（同文件里其它 client 的条目原样保留）。
pub fn save(data_dir: &Path, client_id: &str, set: &TokenSet) -> Result<(), String> {
    let client_id = client_id.trim();
    if client_id.is_empty() {
        return Err("client_id 为空，无法落盘令牌".into());
    }
    let mut store = read_store(data_dir);
    store.insert(client_id.to_string(), set.clone());
    write_store(data_dir, &store)
}

/// 清除某个 client 的令牌；该 client 不存在视为成功。
///
/// 删空后连文件一起删 —— 退出登录不该在磁盘上留一个空壳 `{}`。
pub fn clear(data_dir: &Path, client_id: &str) -> Result<(), String> {
    let mut store = read_store(data_dir);
    if store.remove(client_id.trim()).is_none() {
        return Ok(());
    }
    let path = credentials_path(data_dir);
    if store.is_empty() {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("删除 {} 失败: {error}", path.display())),
        };
    }
    write_store(data_dir, &store)
}

/// 写私有文件：unix 下收紧到 0600（见模块文档）。
fn write_private(path: &Path, contents: &[u8]) -> Result<(), String> {
    std::fs::write(path, contents)
        .map_err(|error| format!("写 {} 失败: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 取可用 access_token：新鲜则直接返回；已过期且有 refresh_token → 先刷新并落盘，再返回新 token。
pub async fn resolve_access_token(
    data_dir: &Path,
    cfg: &OAuthClientConfig,
    client_secret: &str,
) -> Result<String, String> {
    let stored = load(data_dir, &cfg.client_id).ok_or_else(|| {
        "尚未完成该服务的扫码授权（未找到 client_id 对应的凭证）：请先在设置页完成扫码授权"
            .to_string()
    })?;
    if !oauth::is_expired(&stored, oauth::now_ms(), REFRESH_SKEW_MS) {
        return Ok(stored.access_token);
    }
    let refresh_token = stored
        .refresh_token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| "该服务的授权已过期且没有 refresh_token：请重新扫码授权".to_string())?;
    let refreshed = oauth::refresh(cfg, client_secret, refresh_token)
        .await
        .map_err(|error| format!("刷新授权失败（请重新扫码授权）：{error}"))?;
    // 刷新响应可能不回 refresh_token —— 保留旧的，否则下次再过期就没得刷了。
    let merged = TokenSet {
        refresh_token: refreshed
            .refresh_token
            .clone()
            .or(stored.refresh_token.clone()),
        ..refreshed
    };
    save(data_dir, &cfg.client_id, &merged)?;
    Ok(merged.access_token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use std::sync::Arc;

    const CLIENT: &str = "client-123";

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("gw-office-store-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    fn token() -> TokenSet {
        TokenSet {
            access_token: "at".into(),
            refresh_token: Some("rt".into()),
            expires_at: oauth::now_ms() + 3_600_000,
            scope: Some("all".into()),
            user_id: Some("u".into()),
            client_id: Some(CLIENT.into()),
        }
    }

    #[test]
    fn save_load_roundtrip_and_clear() {
        let dir = temp_dir("roundtrip");
        assert!(load(&dir, CLIENT).is_none(), "没存过 → None");
        let expected = token();
        save(&dir, CLIENT, &expected).expect("save");
        assert_eq!(load(&dir, CLIENT), Some(expected));
        clear(&dir, CLIENT).expect("clear");
        assert!(load(&dir, CLIENT).is_none(), "清掉后 → None");
        clear(&dir, CLIENT).expect("重复 clear 不报错");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 两个 client 各存各的 —— 这是「按 client_id 分键」的核心保证。
    #[test]
    fn two_clients_do_not_overwrite_each_other() {
        let dir = temp_dir("two-clients");
        let mut other = token();
        other.access_token = "at-2".into();

        save(&dir, "cid-a", &token()).expect("save a");
        save(&dir, "cid-b", &other).expect("save b");
        assert_eq!(load(&dir, "cid-a").unwrap().access_token, "at");
        assert_eq!(load(&dir, "cid-b").unwrap().access_token, "at-2");

        clear(&dir, "cid-a").expect("clear a");
        assert!(load(&dir, "cid-a").is_none());
        assert_eq!(
            load(&dir, "cid-b").unwrap().access_token,
            "at-2",
            "删一个不该动到另一个"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 删空即删文件，不留空壳 `{}`。
    #[test]
    fn clear_removes_file_when_last_entry_is_gone() {
        let dir = temp_dir("clear-file");
        save(&dir, CLIENT, &token()).expect("save");
        assert!(credentials_path(&dir).exists());
        clear(&dir, CLIENT).expect("clear");
        assert!(
            !credentials_path(&dir).exists(),
            "最后一个条目删掉后文件不该留下"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_treats_corrupt_file_as_absent() {
        let dir = temp_dir("corrupt");
        save(&dir, CLIENT, &token()).expect("save");
        std::fs::write(credentials_path(&dir), b"{ not json").expect("write");
        assert!(load(&dir, CLIENT).is_none(), "损坏 → None（不 panic）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_rejects_blank_client_id() {
        let dir = temp_dir("blank-client");
        let error = save(&dir, "  ", &token()).unwrap_err();
        assert!(error.contains("client_id"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn save_sets_private_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("perms");
        save(&dir, CLIENT, &token()).expect("save");
        let mode = std::fs::metadata(credentials_path(&dir))
            .expect("meta")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "令牌文件必须是 0600");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn resolve_returns_fresh_token_without_network() {
        let dir = temp_dir("fresh");
        save(&dir, CLIENT, &token()).expect("save");
        // 端点留空也不会被访问：新鲜 token 不该触发任何网络请求。
        let cfg = OAuthClientConfig::new(CLIENT, "https://localhost/cb");
        let token = resolve_access_token(&dir, &cfg, "secret")
            .await
            .expect("fresh");
        assert_eq!(token, "at");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn resolve_without_stored_token_points_to_authorize() {
        let dir = temp_dir("absent");
        let cfg = OAuthClientConfig::new(CLIENT, "https://localhost/cb");
        let error = resolve_access_token(&dir, &cfg, "secret")
            .await
            .unwrap_err();
        assert!(error.contains("扫码授权"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 令牌按 client_id 分键：别的 client 有令牌，不等于这个 client 有。
    #[tokio::test]
    async fn resolve_ignores_other_clients_tokens() {
        let dir = temp_dir("other-client");
        save(&dir, "someone-else", &token()).expect("save");
        let cfg = OAuthClientConfig::new(CLIENT, "https://localhost/cb");
        let error = resolve_access_token(&dir, &cfg, "secret")
            .await
            .unwrap_err();
        assert!(error.contains("扫码授权"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn resolve_without_refresh_token_reports_reauth() {
        let dir = temp_dir("no-refresh");
        save(
            &dir,
            CLIENT,
            &TokenSet {
                access_token: "old".into(),
                refresh_token: None,
                expires_at: oauth::now_ms() - 1000,
                scope: None,
                user_id: None,
                client_id: None,
            },
        )
        .expect("save");
        let cfg = OAuthClientConfig::new(CLIENT, "https://localhost/cb");
        let error = resolve_access_token(&dir, &cfg, "secret")
            .await
            .unwrap_err();
        assert!(error.contains("重新扫码授权"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn resolve_refreshes_expired_token_and_persists() {
        let dir = temp_dir("refresh");
        save(
            &dir,
            CLIENT,
            &TokenSet {
                access_token: "old".into(),
                refresh_token: Some("rt".into()),
                expires_at: oauth::now_ms() - 1000,
                scope: None,
                user_id: None,
                client_id: Some(CLIENT.into()),
            },
        )
        .expect("save");

        let (url, seen) = refresh_server().await;
        let mut cfg = OAuthClientConfig::new(CLIENT, "https://localhost/cb");
        cfg.token_url = url;
        let token = resolve_access_token(&dir, &cfg, "secret")
            .await
            .expect("refresh ok");
        assert_eq!(token, "new-token");
        assert!(
            seen.lock().contains("grant_type=refresh_token"),
            "要走刷新 grant：{}",
            seen.lock()
        );

        let stored = load(&dir, CLIENT).expect("stored");
        assert_eq!(stored.access_token, "new-token", "新 token 要落盘");
        assert_eq!(
            stored.refresh_token.as_deref(),
            Some("rt"),
            "响应没回 refresh_token 时保留旧的"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 起一个「收一个请求、记下来、回一段 token JSON」的本地刷新端点。
    async fn refresh_server() -> (String, Arc<Mutex<String>>) {
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
                let body = r#"{"access_token":"new-token","expires_in":3600}"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
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
