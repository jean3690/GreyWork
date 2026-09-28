//! 内置登录：密码 → 不透明会话 token（cookie 或 Bearer 二选一），会话存内存。
//!
//! 设计取舍：
//! - **不透明随机 token + 内存表**，不用签名 cookie：省掉一个签名密钥（也就省掉
//!   「密钥泄漏」这一整类问题）。代价是进程重启即全体会话失效 —— 单用户自托管可接受。
//! - 内存里存 `SHA-256(token)` 而非明文 token：进程被读内存时少泄漏一份可直接用的凭证。
//! - token 是 256-bit 随机，不可枚举，故查表无需常量时间比较；密码校验由 argon2 保证
//!   常量时间。
//! - **密码错误 / token 无效 / 会话过期对外一律 401「未认证」**，不泄漏是哪一种。

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use argon2::password_hash::{PasswordHash, PasswordVerifier};
use argon2::Argon2;
use axum::extract::FromRequestParts;
use axum::http::header;
use axum::http::request::Parts;
use parking_lot::Mutex;
use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::state::AppState;

/// 会话 cookie 名。
pub const COOKIE_NAME: &str = "gw_session";

struct Session {
    expires_at: SystemTime,
}

/// 会话表 + 密码校验。
pub struct SessionStore {
    sessions: Mutex<HashMap<[u8; 32], Session>>,
    ttl: Duration,
    password_hash: String,
}

impl SessionStore {
    /// `password_hash_phc` 是 argon2 PHC 串（见 [`crate::config::resolve_password`]）。
    pub fn new(password_hash_phc: &str, ttl: Duration) -> Result<Self, String> {
        PasswordHash::new(password_hash_phc)
            .map_err(|error| format!("密码哈希解析失败: {error}"))?;
        Ok(Self {
            sessions: Mutex::new(HashMap::new()),
            ttl,
            password_hash: password_hash_phc.to_string(),
        })
    }

    /// 校验密码；成功则签发新 token（明文只在此返回一次）。
    pub fn login(&self, password: &str) -> Option<String> {
        let parsed = PasswordHash::new(&self.password_hash).ok()?;
        // argon2 的 verify 是常量时间比较（password-hash 保证）。
        if Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_err()
        {
            return None;
        }
        let token = random_token();
        let mut sessions = self.sessions.lock();
        prune_expired(&mut sessions);
        sessions.insert(
            hash_token(&token),
            Session {
                expires_at: SystemTime::now() + self.ttl,
            },
        );
        Some(token)
    }

    /// 校验 token；有效则返回到期时刻（unix 毫秒）。
    pub fn authenticate(&self, token: &str) -> Option<u64> {
        let mut sessions = self.sessions.lock();
        prune_expired(&mut sessions);
        sessions
            .get(&hash_token(token))
            .map(|session| to_unix_ms(session.expires_at))
    }

    /// 注销一个 token（不存在也当成功）。
    pub fn logout(&self, token: &str) {
        self.sessions.lock().remove(&hash_token(token));
    }
}

fn prune_expired(sessions: &mut HashMap<[u8; 32], Session>) {
    let now = SystemTime::now();
    sessions.retain(|_, session| session.expires_at > now);
}

fn to_unix_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn random_token() -> String {
    use base64::Engine;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("getrandom 失败");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn hash_token(token: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hasher.finalize().into()
}

/* ===== cookie 头 ===== */

/// 构造会话 cookie 的 `Set-Cookie` 值。
pub fn session_cookie(token: &str, ttl: Duration, secure: bool) -> String {
    let mut cookie = format!(
        "{COOKIE_NAME}={token}; HttpOnly; Path=/; SameSite=Strict; Max-Age={}",
        ttl.as_secs()
    );
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

/// 清空会话 cookie 的 `Set-Cookie` 值。
///
/// `secure` 必须与 [`session_cookie`] 一致：带 `Secure` 的 cookie 只能被带 `Secure` 的
/// `Set-Cookie` 覆盖（RFC 6265bis），否则 TLS 反代下登出清不掉浏览器里的会话 cookie。
pub fn clear_cookie(secure: bool) -> String {
    let mut cookie = format!("{COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0");
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

/// 从 `Cookie` 头里取出会话 token。
pub fn token_from_cookie(cookie_header: &str) -> Option<String> {
    cookie_header.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        (name == COOKIE_NAME && !value.is_empty()).then(|| value.to_string())
    })
}

fn bearer_token(parts: &Parts) -> Option<String> {
    let value = parts.headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))?;
    (!token.is_empty()).then(|| token.to_string())
}

fn cookie_token(parts: &Parts) -> Option<String> {
    let value = parts.headers.get(header::COOKIE)?.to_str().ok()?;
    token_from_cookie(value)
}

/// 已鉴权请求携带的会话 token（登出需要原 token）。
///
/// 提取器即鉴权：cookie 与 Bearer 等价，任一有效即可；否则 `401`。
pub struct AuthSession(pub String);

impl FromRequestParts<AppState> for AuthSession {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = bearer_token(parts)
            .or_else(|| cookie_token(parts))
            .ok_or(ApiError::Unauthorized)?;
        state
            .sessions
            .authenticate(&token)
            .ok_or(ApiError::Unauthorized)?;
        Ok(AuthSession(token))
    }
}

/* ===== 登录限流 ===== */

/// 同一 IP 连续失败超限后冷却，防在线暴力破解。
pub struct LoginThrottle {
    attempts: Mutex<HashMap<IpAddr, (u32, SystemTime)>>,
    max_failures: u32,
    cooldown: Duration,
}

impl Default for LoginThrottle {
    fn default() -> Self {
        Self::new(5, Duration::from_secs(60))
    }
}

impl LoginThrottle {
    pub fn new(max_failures: u32, cooldown: Duration) -> Self {
        Self {
            attempts: Mutex::new(HashMap::new()),
            max_failures,
            cooldown,
        }
    }

    /// 该 IP 当前是否处于冷却期（应拒绝登录）。
    pub fn is_blocked(&self, ip: IpAddr) -> bool {
        let now = SystemTime::now();
        let mut attempts = self.attempts.lock();
        match attempts.get(&ip) {
            Some((count, until)) if *count >= self.max_failures && *until > now => true,
            Some((_, until)) if *until <= now => {
                attempts.remove(&ip);
                false
            }
            _ => false,
        }
    }

    pub fn record_failure(&self, ip: IpAddr) {
        let now = SystemTime::now();
        let mut attempts = self.attempts.lock();
        let entry = attempts.entry(ip).or_insert((0, now + self.cooldown));
        entry.0 += 1;
        entry.1 = now + self.cooldown;
    }

    pub fn record_success(&self, ip: IpAddr) {
        self.attempts.lock().remove(&ip);
    }
}

/// 便于测试/构造共享限流器。
pub type SharedThrottle = Arc<LoginThrottle>;

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> SessionStore {
        let hash = crate::config::hash_password("hunter2").unwrap();
        SessionStore::new(&hash, Duration::from_secs(3600)).unwrap()
    }

    #[test]
    fn login_issues_token_and_authenticate_accepts_it() {
        let store = store();
        let token = store.login("hunter2").expect("密码正确应签发");
        assert!(store.authenticate(&token).is_some());
        assert!(store.authenticate("bogus").is_none());
    }

    #[test]
    fn wrong_password_issues_nothing() {
        let store = store();
        assert!(store.login("wrong").is_none());
    }

    #[test]
    fn logout_invalidates_token() {
        let store = store();
        let token = store.login("hunter2").unwrap();
        store.logout(&token);
        assert!(store.authenticate(&token).is_none());
    }

    #[test]
    fn expired_session_is_rejected() {
        let hash = crate::config::hash_password("pw").unwrap();
        let store = SessionStore::new(&hash, Duration::from_secs(0)).unwrap();
        let token = store.login("pw").unwrap();
        // TTL=0 → 立即过期。
        assert!(store.authenticate(&token).is_none());
    }

    #[test]
    fn cookie_header_has_required_attributes() {
        let cookie = session_cookie("tok", Duration::from_secs(120), true);
        assert!(cookie.contains("gw_session=tok"));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));
        assert!(cookie.contains("Max-Age=120"));
        assert!(cookie.contains("Secure"));
    }

    #[test]
    fn clear_cookie_matches_session_cookie_secure_flag() {
        let plain = clear_cookie(false);
        assert!(plain.contains("gw_session=;"));
        assert!(plain.contains("HttpOnly"));
        assert!(plain.contains("Path=/"));
        assert!(plain.contains("SameSite=Strict"));
        assert!(plain.contains("Max-Age=0"));
        assert!(!plain.contains("Secure"));

        let secure = clear_cookie(true);
        assert!(secure.contains("Max-Age=0"));
        assert!(secure.contains("Secure"));
    }

    #[test]
    fn token_from_cookie_extracts_value() {
        assert_eq!(
            token_from_cookie("a=1; gw_session=abc; b=2"),
            Some("abc".to_string())
        );
        assert_eq!(token_from_cookie("other=1"), None);
        assert_eq!(token_from_cookie("gw_session="), None);
    }

    #[test]
    fn throttle_blocks_after_max_failures() {
        let throttle = LoginThrottle::new(2, Duration::from_secs(60));
        let ip: IpAddr = "127.0.0.1".parse().unwrap();
        assert!(!throttle.is_blocked(ip));
        throttle.record_failure(ip);
        assert!(!throttle.is_blocked(ip));
        throttle.record_failure(ip);
        assert!(throttle.is_blocked(ip));
        throttle.record_success(ip);
        assert!(!throttle.is_blocked(ip));
    }
}
