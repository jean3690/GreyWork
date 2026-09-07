//! OS 级沙盒（方案 2 P1）：Linux bubblewrap 包裹外部 agent 进程。
//!
//! 设计：
//! - 系统路径只读绑定（/usr /lib /lib64 /bin /etc /opt …）
//! - 家目录只读绑定（agent 读取 ~/.config、~/.claude 等配置）
//! - 工作区读写绑定（产物落盘处）
//! - `/tmp` 使用 tmpfs（隔离临时文件）
//! - `--unshare-net` 默认关闭网络（full 模式放行）
//! - `--die-with-parent`：宿主退出即回收子进程
//!
//! 包裹命令以 JSON 形式交给 `AcpAgent::from_str`（shell_words 对含空格的
//! 绝对路径不可靠，JSON 配置天然免转义）。macOS / Windows 平台本期未实现，
//! 返回明确错误文案由前端展示。

use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum SandboxMode {
    #[default]
    Off,
    /// 文件系统隔离 + 网络关闭（--unshare-net）。
    Filesystem,
    /// 文件系统隔离 + 网络放行。
    Full,
}

impl SandboxMode {
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some("fs") => SandboxMode::Filesystem,
            Some("full") => SandboxMode::Full,
            _ => SandboxMode::Off,
        }
    }
}

/// 沙盒能力探测：bwrap 是否存在于 PATH。
pub fn sandbox_available() -> bool {
    std::process::Command::new("bwrap")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Linux 下常见需要只读绑定的系统目录（按需合并）。
fn readonly_system_dirs() -> Vec<PathBuf> {
    ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc", "/opt"]
        .iter()
        .filter(|candidate| Path::new(candidate).is_dir())
        .map(PathBuf::from)
        .collect()
}

/// 将原始 agent 命令包裹进 bwrap 沙盒，返回 JSON 配置串（AcpAgent::from_str 可解析）。
/// workspace 必须是已存在目录；home 为只读家目录（缺失时跳过该绑定）。
pub fn wrap_command(
    mode: SandboxMode,
    workspace: &Path,
    home: Option<&Path>,
    agent_cmd: &str,
) -> Result<String, String> {
    if mode == SandboxMode::Off {
        return Ok(agent_cmd.to_string());
    }
    if !Path::new(workspace).is_dir() {
        return Err(format!(
            "sandbox: workspace must be an existing directory, got {}",
            workspace.display()
        ));
    }

    let mut args: Vec<String> = vec![
        "--die-with-parent".to_string(),
        "--proc".to_string(),
        "/proc".to_string(),
        "--dev".to_string(),
        "/dev".to_string(),
        "--tmpfs".to_string(),
        "/tmp".to_string(),
    ];
    for dir in readonly_system_dirs() {
        args.extend([
            "--ro-bind".to_string(),
            dir.to_string_lossy().into_owned(),
            dir.to_string_lossy().into_owned(),
        ]);
    }
    if let Some(home) = home.filter(|candidate| Path::new(candidate).is_dir()) {
        let home = home.to_string_lossy().into_owned();
        args.extend(["--ro-bind".to_string(), home.clone(), home]);
    }
    let ws = workspace.to_string_lossy().into_owned();
    args.extend(["--bind".to_string(), ws.clone(), ws]);
    if mode == SandboxMode::Filesystem {
        args.push("--unshare-net".to_string());
    }

    // 原始命令经白名单校验后逐 token 展开，作为 bwrap 的 `--` 参数。
    // 命令已通过 validate_spawn_command（无 shell 元字符），whitespace 拆分即安全。
    let tokens = agent_cmd.split_whitespace().collect::<Vec<_>>();
    args.push("--".to_string());
    args.extend(tokens.iter().map(|token| token.to_string()));

    serde_json::to_string(&serde_json::json!({
        "command": "bwrap",
        "args": args,
    }))
    .map_err(|error| format!("sandbox: failed to build wrapper config: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_mode_parse_fails_closed_to_off() {
        assert_eq!(SandboxMode::parse(Some("fs")), SandboxMode::Filesystem);
        assert_eq!(SandboxMode::parse(Some("full")), SandboxMode::Full);
        assert_eq!(SandboxMode::parse(Some("yolo")), SandboxMode::Off);
        assert_eq!(SandboxMode::parse(None), SandboxMode::Off);
        assert_eq!(SandboxMode::parse(Some("FS")), SandboxMode::Off); // 大小写敏感
    }

    #[test]
    fn wrap_off_returns_agent_command_unchanged() {
        let tmp = std::env::temp_dir();
        assert_eq!(
            wrap_command(SandboxMode::Off, &tmp, None, "opencode acp").unwrap(),
            "opencode acp"
        );
    }

    #[test]
    fn wrap_fs_binds_workspace_readonly_system_and_unshares_net() {
        let workspace = std::env::temp_dir().join("greywork-sandbox-ws");
        std::fs::create_dir_all(&workspace).unwrap();
        let config =
            wrap_command(SandboxMode::Filesystem, &workspace, None, "opencode acp").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&config).unwrap();
        assert_eq!(parsed["command"], "bwrap");
        let args = parsed["args"].as_array().unwrap();
        let joined = args.iter().map(|v| v.as_str().unwrap()).collect::<Vec<_>>();
        // 关键 flag 与顺序
        assert!(joined.contains(&"--die-with-parent"));
        assert!(joined.contains(&"--unshare-net"));
        assert!(joined.contains(&"--bind"));
        assert!(joined.contains(&workspace.to_str().unwrap()));
        assert!(joined.windows(2).any(|pair| pair == ["--ro-bind", "/usr"]));
        // 原始命令在 `--` 之后
        let sep = joined.iter().position(|arg| *arg == "--").unwrap();
        assert_eq!(&joined[sep + 1..], &["opencode", "acp"]);
        std::fs::remove_dir_all(&workspace).unwrap();
    }

    #[test]
    fn wrap_full_does_not_unshare_net() {
        let workspace = std::env::temp_dir().join("greywork-sandbox-ws2");
        std::fs::create_dir_all(&workspace).unwrap();
        let config = wrap_command(
            SandboxMode::Full,
            &workspace,
            None,
            "npx -y @agentclientprotocol/codex-acp",
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&config).unwrap();
        let joined = parsed["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(!joined.contains(&"--unshare-net"));
        std::fs::remove_dir_all(&workspace).unwrap();
    }

    #[test]
    fn wrap_rejects_missing_workspace() {
        let ghost = std::env::temp_dir().join("greywork-sandbox-ghost");
        assert!(wrap_command(SandboxMode::Filesystem, &ghost, None, "opencode acp").is_err());
    }
}
