//! 启动命令白名单、环境变量净化、握手超时窗口。

use crate::acp_process::StderrTail;

/// 已知 ACP agent 入口程序（basename）。通用运行时（node/npx/bun/…）允许，
/// 因为部分 agent 以 npx 包形式分发（如 zed 桥接）。
pub(super) const ALLOWED_AGENT_PROGRAMS: &[&str] = &[
    "opencode",
    "codex",
    "claude",
    "gemini",
    "crush",
    "qwen",
    "droid",
    "amp",
    "amp-acp",
    "kimi",
    "glm-acp-agent",
    "goose",
    "copilot",
    "cursor-agent",
    "aider",
    "node",
    "npx",
    "bun",
    "bunx",
    "deno",
    "python3",
    "uvx",
];

/// 把 agent stderr 尾部拼进失败串，让「起不来」有原因可看（best-effort：agent 可能
/// 还什么都没吐，或输出尚在管道里没读出来）。
pub(super) fn stderr_hint(tail: &StderrTail) -> String {
    let text = tail.lock();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("\n--- agent stderr (tail) ---\n{trimmed}")
    }
}

/// 握手就绪窗口：npx/npm 型命令首次运行需按需下载 + 适配器冷启动（codex-acp 要拉起
/// Codex App Server，实测首次可达 ~60s），放宽到 120s；原生二进制启动快，保持 10s
/// 以便「命令不存在」快速失败。
pub(super) fn handshake_timeout_secs(command: &str) -> u64 {
    let program = command.split_whitespace().next().unwrap_or_default();
    if matches!(program, "npx" | "npm" | "yarn" | "pnpm" | "deno" | "bunx") {
        120
    } else {
        10
    }
}

/// 单个后端的启动环境变量条数 / 单值长度上限。
pub(super) const MAX_PROVIDER_ENV_VARS: usize = 32;
pub(super) const MAX_PROVIDER_ENV_VALUE_CHARS: usize = 4096;

/// 环境变量名必须是 POSIX 标识符（首字符字母或 `_`，其余字母数字下划线，≤64）。
fn is_valid_env_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 {
        return false;
    }
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 净化前端给的后端环境变量：整批拒绝而不是静默丢弃（少注入一个 API key 会变成
/// 「agent 莫名其妙没权限」，比明确报错难查得多）。
pub(super) fn sanitize_env(
    raw: Option<std::collections::HashMap<String, String>>,
) -> Result<Vec<(String, String)>, String> {
    let Some(map) = raw else {
        return Ok(Vec::new());
    };
    if map.len() > MAX_PROVIDER_ENV_VARS {
        return Err(format!("环境变量过多（最多 {MAX_PROVIDER_ENV_VARS} 条）"));
    }
    let mut vars = Vec::with_capacity(map.len());
    for (key, value) in map {
        let name = key.trim().to_string();
        if !is_valid_env_name(&name) {
            return Err(format!("非法环境变量名: {key:?}"));
        }
        if value.contains('\0') {
            return Err(format!("环境变量 {name} 的值含 NUL 字符"));
        }
        if value.chars().count() > MAX_PROVIDER_ENV_VALUE_CHARS {
            return Err(format!(
                "环境变量 {name} 的值过长（最多 {MAX_PROVIDER_ENV_VALUE_CHARS} 字符）"
            ));
        }
        vars.push((name, value));
    }
    Ok(vars)
}
