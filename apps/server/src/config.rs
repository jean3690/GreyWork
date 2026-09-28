//! 服务端配置：默认值 → 配置文件（JSON）→ 环境变量，逐层覆盖。
//!
//! 单用户自托管场景，配置面刻意做小：绑定地址、数据目录、会话 TTL、密码来源、
//! **冻结的 agent 程序白名单**、**预置授权根**、以及沙盒/档位策略上限。
//!
//! 最后两项是安全项，不是便利项：
//! - `agent_programs`：headless 端**不读** `db.enabled_agent_programs()`（DB 可被客户端
//!   经 `db_agents_sync` 改写，是 RCE 面），只信这份配置。
//! - `workspace_roots`：headless 没有原生文件夹选择器，授权根只能在配置里给。

use std::path::{Path, PathBuf};

/// 服务端运行配置。
///
/// `deny_unknown_fields`：配置里写错字段名时直接报错，而不是静默忽略 —— 一个拼错的
/// `workspace_roots` 会让预置授权根悄悄失效。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    /// 监听地址，如 `127.0.0.1:8787`；容器里通常 `0.0.0.0:8787`。
    pub bind: String,
    /// 数据目录：db / logs / 通道凭据 / 路径授权账本 / auth.json 都落这里。
    pub data_dir: PathBuf,
    /// agent 沙盒要只读挂载的 HOME。缺省用 `HOME`（unix）/ `USERPROFILE`（windows）。
    pub home_dir: Option<PathBuf>,
    /// 会话有效期（秒）。
    pub session_ttl_secs: u64,
    /// 首选：argon2 PHC 串（环境里无明文密码）。
    pub password_hash: Option<String>,
    /// 次选：明文密码（dev / 首启便利），启动时在内存里哈希，不落盘。
    pub password: Option<String>,
    /// **冻结**的 agent 额外放行面（与内置白名单取并集）。
    pub agent_programs: Vec<String>,
    /// 预授权工作区根（headless 无原生选择器，只能在配置里给）。
    pub workspace_roots: Vec<PathBuf>,
    /// 沙盒策略（`auto` | `off` | `fs` | `full`）；服务端用它覆盖请求里的同名字段。
    pub sandbox: Option<String>,
    /// 权限档位（`read-only` | `workspace` | `full`）；服务端用它覆盖请求里的同名字段。
    pub tier: Option<String>,
    /// cookie 是否带 `Secure`（在 TLS 反代之后应置 true）。
    pub secure_cookie: bool,
    /// 非空时，对所有非 GET/HEAD 请求校验 `Origin` 必须在此白名单内。
    pub allowed_origins: Vec<String>,
    /// 允许被 iframe 内嵌的额外 origin（云端 Office 的文档地址）。
    ///
    /// 桌面壳的 CSP 写死在打包配置里，所以桌面端只能内嵌三个预设厂商；服务端的 CSP 是
    /// 启动时按这里拼的（见 `middleware::content_security_policy`），于是「自定义云端
    /// Office」只在服务端态下真正可用。留空 = 不生成 `frame-src`，回落到
    /// `default-src 'self'`（行为与加这个配置项之前完全一致）。
    ///
    /// 只接受 `scheme://host[:port]` 形态；非法项会被丢弃并在启动日志里点名。
    pub frame_origins: Vec<String>,
    /// 构建产物目录（SPA）。`None` = 不托管静态资源（仅 /api）。
    ///
    /// 刻意不给默认路径：`cargo run` 开发态、纯 API 部署都不该悄悄挂上一份过期的
    /// `apps/desktop/dist`；`<exe 同目录>/dist` 这种默认对从 `target/debug` 起的人更是惊吓。
    /// Docker 里显式设 `GREYWORK_STATIC_DIR=/app/dist`。
    pub static_dir: Option<PathBuf>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:8787".to_string(),
            data_dir: default_data_dir(),
            home_dir: None,
            session_ttl_secs: 30 * 24 * 3600,
            password_hash: None,
            password: None,
            agent_programs: Vec::new(),
            workspace_roots: Vec::new(),
            // fail-closed：档位默认最严；沙盒默认 auto（bwrap 可用则 fs，不可用降级 off 并告警）。
            sandbox: Some("auto".to_string()),
            tier: Some("read-only".to_string()),
            secure_cookie: false,
            allowed_origins: Vec::new(),
            frame_origins: Vec::new(),
            static_dir: None,
        }
    }
}

impl ServerConfig {
    /// 会话有效期。
    pub fn session_ttl(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.session_ttl_secs)
    }

    /// 按 `默认值 → 配置文件 → 环境变量` 的顺序加载。
    pub fn load() -> Result<Self, String> {
        let mut config = ServerConfig::default();

        // 配置文件路径：`GREYWORK_CONFIG`，缺省 `<data_dir>/server.json`。
        // 注意：此处 `<data_dir>` 取的是默认值（或 `GREYWORK_DATA_DIR`）。要迁移数据目录，
        // 用环境变量或显式 `GREYWORK_CONFIG` —— 文档写明。
        let file = std::env::var_os("GREYWORK_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| config.data_dir.join("server.json"));
        if file.exists() {
            let raw = std::fs::read(&file)
                .map_err(|error| format!("读取配置文件 {} 失败: {error}", file.display()))?;
            config = serde_json::from_slice(&raw)
                .map_err(|error| format!("解析配置文件 {} 失败: {error}", file.display()))?;
        }

        config.apply_env()?;
        Ok(config)
    }

    /// 环境变量覆盖（最高优先级）。`GREYWORK_*` 全部可选。
    fn apply_env(&mut self) -> Result<(), String> {
        if let Some(value) = env_str("GREYWORK_BIND") {
            self.bind = value;
        }
        if let Some(value) = env_str("GREYWORK_DATA_DIR") {
            self.data_dir = PathBuf::from(value);
        }
        if let Some(value) = env_str("GREYWORK_HOME_DIR") {
            self.home_dir = Some(PathBuf::from(value));
        }
        if let Some(value) = env_str("GREYWORK_SESSION_TTL") {
            self.session_ttl_secs = value
                .parse()
                .map_err(|_| format!("GREYWORK_SESSION_TTL 不是整数: {value}"))?;
        }
        if let Some(value) = env_str("GREYWORK_PASSWORD_HASH") {
            self.password_hash = Some(value);
        }
        if let Some(value) = env_str("GREYWORK_PASSWORD") {
            self.password = Some(value);
        }
        if let Some(value) = env_str("GREYWORK_AGENT_PROGRAMS") {
            self.agent_programs = split_list(&value, ',');
        }
        if let Some(value) = env_str("GREYWORK_WORKSPACE_ROOTS") {
            self.workspace_roots = split_list(&value, PATH_LIST_SEP)
                .into_iter()
                .map(PathBuf::from)
                .collect();
        }
        if let Some(value) = env_str("GREYWORK_SANDBOX") {
            self.sandbox = Some(value);
        }
        if let Some(value) = env_str("GREYWORK_TIER") {
            self.tier = Some(value);
        }
        if let Some(value) = env_str("GREYWORK_SECURE_COOKIE") {
            self.secure_cookie = parse_bool(&value);
        }
        if let Some(value) = env_str("GREYWORK_ALLOWED_ORIGINS") {
            self.allowed_origins = split_list(&value, ',');
        }
        if let Some(value) = env_str("GREYWORK_FRAME_ORIGINS") {
            self.frame_origins = split_list(&value, ',');
        }
        if let Some(value) = env_str("GREYWORK_STATIC_DIR") {
            self.static_dir = Some(PathBuf::from(value));
        }
        Ok(())
    }
}

/// 路径列表分隔符：unix 用 `:`，windows 用 `;`。
#[cfg(windows)]
const PATH_LIST_SEP: char = ';';
#[cfg(not(windows))]
const PATH_LIST_SEP: char = ':';

/// 默认数据目录：`GREYWORK_DATA_DIR` 或 `<home>/.greyWork-server`。
pub fn default_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("GREYWORK_DATA_DIR") {
        return PathBuf::from(dir);
    }
    match resolve_home() {
        Ok(home) => home.join(".greyWork-server"),
        // 家目录都取不到（极简容器）时退回相对路径，让 create_dir_all 的报错去说话。
        Err(_) => PathBuf::from(".greyWork-server"),
    }
}

/// 家目录：`HOME`（unix）/ `USERPROFILE`（windows）。
pub fn resolve_home() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| format!("无法确定家目录：环境变量 {key} 未设置"))
}

/// 校验静态目录：配了就**必须**有效 —— 否则容器会「healthy 但 UI 404」。
///
/// 容器 `HEALTHCHECK` 打的是 `/api/health`，UI 404 时它照样绿；这里若只警告，
/// 坏镜像就会以 healthy 状态发出去，所以必须当场硬失败。
pub fn resolve_static_dir(config: &ServerConfig) -> Result<Option<PathBuf>, String> {
    let Some(dir) = &config.static_dir else {
        return Ok(None);
    };
    let index = dir.join("index.html");
    if !index.is_file() {
        return Err(format!(
            "GREYWORK_STATIC_DIR={} 无效：未找到 {}。\
             （配置了静态托管就必须有 index.html；只想提供 /api 请删除该配置）",
            dir.display(),
            index.display()
        ));
    }
    Ok(Some(dir.clone()))
}

fn env_str(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

fn split_list(value: &str, sep: char) -> Vec<String> {
    value
        .split(sep)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn parse_bool(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/* ===== 密码 bootstrap ===== */

/// 解析出的密码来源。
pub struct ResolvedPassword {
    /// argon2 PHC 串，交给 [`crate::auth::SessionStore`] 校验。
    pub hash: String,
    /// 仅当「本次自动生成」时存在 —— 调用方需把明文打印一次给用户。
    pub generated_plaintext: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct AuthFile {
    password_hash: String,
}

/// 五档密码来源（优先级从高到低）：
///
/// 1. `password_hash`（环境变量 / 配置文件里的 argon2 PHC 串）；
/// 2. `<data_dir>/auth.json`（`set-password` 子命令写入，0600）；
/// 3. `password`（明文，仅 dev 便利，启动时哈希到内存）；
/// 4. 都没有 → 生成随机密码，写 `<data_dir>/auth.json`（0600），明文只回传一次。
pub fn resolve_password(config: &ServerConfig) -> Result<ResolvedPassword, String> {
    if let Some(hash) = config
        .password_hash
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        // 早校验：配错哈希不该等到第一次登录才暴露。
        argon2::PasswordHash::new(hash)
            .map_err(|error| format!("GREYWORK_PASSWORD_HASH 不是合法 argon2 串: {error}"))?;
        return Ok(ResolvedPassword {
            hash: hash.to_string(),
            generated_plaintext: None,
        });
    }

    let auth_path = config.data_dir.join("auth.json");
    if let Some(hash) = read_auth_hash(&auth_path)? {
        return Ok(ResolvedPassword {
            hash,
            generated_plaintext: None,
        });
    }

    if let Some(plaintext) = config.password.as_deref().filter(|value| !value.is_empty()) {
        let hash = hash_password(plaintext)?;
        return Ok(ResolvedPassword {
            hash,
            generated_plaintext: None,
        });
    }

    let plaintext = generate_password()?;
    let hash = hash_password(&plaintext)?;
    write_auth_hash(&auth_path, &hash)?;
    Ok(ResolvedPassword {
        hash,
        generated_plaintext: Some(plaintext),
    })
}

/// 用 argon2 哈希一个明文密码，返回 PHC 串（`hash-password` 子命令也用它）。
pub fn hash_password(password: &str) -> Result<String, String> {
    use argon2::password_hash::{PasswordHasher, SaltString};

    // 自己取盐（getrandom）而不依赖 argon2 的 `rand` 特性，少一个版本统一面。
    let mut salt_bytes = [0u8; 16];
    getrandom::fill(&mut salt_bytes).map_err(|error| format!("生成盐失败: {error}"))?;
    let salt =
        SaltString::encode_b64(&salt_bytes).map_err(|error| format!("编码盐失败: {error}"))?;
    argon2::Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| format!("密码哈希失败: {error}"))
}

/// 生成 24 字符的随机密码（18 字节 → base64url 无填充）。
fn generate_password() -> Result<String, String> {
    use base64::Engine;

    let mut bytes = [0u8; 18];
    getrandom::fill(&mut bytes).map_err(|error| format!("生成密码失败: {error}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

fn read_auth_hash(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw =
        std::fs::read(path).map_err(|error| format!("读取 {} 失败: {error}", path.display()))?;
    let parsed: AuthFile = serde_json::from_slice(&raw)
        .map_err(|error| format!("解析 {} 失败: {error}", path.display()))?;
    Ok(Some(parsed.password_hash))
}

/// 原子写入 `auth.json` 并置 0600：先写临时文件、设权限、再 rename。
pub fn write_auth_hash(path: &Path, hash: &str) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(&AuthFile {
        password_hash: hash.to_string(),
    })
    .map_err(|error| format!("序列化 auth.json 失败: {error}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &body).map_err(|error| format!("写入 {} 失败: {error}", tmp.display()))?;
    set_owner_only(&tmp)?;
    std::fs::rename(&tmp, path)
        .map_err(|error| format!("替换 {} 失败: {error}", path.display()))?;
    Ok(())
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("设置 {} 权限失败: {error}", path.display()))
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> Result<(), String> {
    // 非 unix 平台没有 POSIX 权限位；依赖用户目录本身的 ACL。
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_list_trims_and_drops_empties() {
        assert_eq!(split_list("a, b ,,c", ','), vec!["a", "b", "c"]);
        assert!(split_list("  ", ',').is_empty());
    }

    #[test]
    fn parse_bool_accepts_common_truthy() {
        for truthy in ["1", "true", "YES", "On"] {
            assert!(parse_bool(truthy), "{truthy} 应为真");
        }
        for falsy in ["0", "false", "", "no", "off"] {
            assert!(!parse_bool(falsy), "{falsy} 应为假");
        }
    }

    #[test]
    fn resolve_password_prefers_explicit_hash() {
        let config = ServerConfig {
            password_hash: Some(hash_password("secret").unwrap()),
            password: Some("ignored".to_string()),
            ..ServerConfig::default()
        };
        let resolved = resolve_password(&config).unwrap();
        assert!(resolved.generated_plaintext.is_none());
        assert!(argon2::PasswordHash::new(&resolved.hash).is_ok());
    }

    #[test]
    fn resolve_password_generates_and_persists_when_absent() {
        let tmp = std::env::temp_dir().join(format!("gw-cfg-pw-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let config = ServerConfig {
            data_dir: tmp.clone(),
            ..ServerConfig::default()
        };
        let resolved = resolve_password(&config).unwrap();
        let plaintext = resolved.generated_plaintext.expect("应自动生成密码");
        assert_eq!(plaintext.len(), 24);
        assert!(tmp.join("auth.json").exists(), "应落 auth.json");

        // 第二次解析读回同一哈希，不再生成。
        let again = resolve_password(&config).unwrap();
        assert!(again.generated_plaintext.is_none());
        assert_eq!(again.hash, resolved.hash);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_static_dir_is_none_when_unset() {
        let config = ServerConfig::default();
        assert!(resolve_static_dir(&config).unwrap().is_none());
    }

    #[test]
    fn resolve_static_dir_errors_when_index_missing() {
        let tmp = std::env::temp_dir().join(format!("gw-cfg-static-miss-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let config = ServerConfig {
            static_dir: Some(tmp.clone()),
            ..ServerConfig::default()
        };
        let error = resolve_static_dir(&config).expect_err("缺 index.html 必须报错");
        assert!(
            error.contains("index.html"),
            "错误信息应点明缺什么: {error}"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_static_dir_accepts_dir_with_index() {
        let tmp = std::env::temp_dir().join(format!("gw-cfg-static-ok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("index.html"), "<div id=\"app\"></div>").unwrap();

        let config = ServerConfig {
            static_dir: Some(tmp.clone()),
            ..ServerConfig::default()
        };
        assert_eq!(resolve_static_dir(&config).unwrap(), Some(tmp.clone()));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn auth_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = std::env::temp_dir().join(format!("gw-cfg-mode-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let path = tmp.join("auth.json");
        write_auth_hash(&path, &hash_password("x").unwrap()).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "auth.json 必须 0600");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
