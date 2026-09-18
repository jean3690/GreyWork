//! OS 级沙盒：Linux bubblewrap 包裹外部 agent 进程。
//!
//! - 系统路径只读，工作区读写，`/tmp` 独立；
//! - `fs` 关闭网络，`full` 放行网络；
//! - `auto` 在 bwrap 可用时等价于 `fs`，否则降级为 `off` 并记录告警；
//! - **bwrap 只有 Linux 有**，所以 Windows/macOS 上任何档位都会降级为 `off`（同样告警），
//!   而不是让 agent 直接起不来 —— 设置可能是从别的机器同步过来的；
//! - 不挂载完整 HOME，只把已存在的 Agent 配置目录/文件只读映射到隔离 HOME。
//!
//! 包裹命令以 JSON 交给 `AcpAgent::from_str`，避免命令路径再经 shell 解释。

use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxMode {
    Auto,
    Off,
    /// 文件系统隔离 + 网络关闭（--unshare-net）。
    Filesystem,
    /// 文件系统隔离 + 网络放行。
    Full,
}

impl SandboxMode {
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.map(str::trim) {
            None | Some("") | Some("auto") => Ok(SandboxMode::Auto),
            Some("off") => Ok(SandboxMode::Off),
            Some("fs") => Ok(SandboxMode::Filesystem),
            Some("full") => Ok(SandboxMode::Full),
            Some(value) => Err(format!("sandbox: unknown mode {value:?}")),
        }
    }

    /// 解析出真正可用的档位，并告知是否发生了降级（调用方据此记录告警）。
    ///
    /// `available` = 本机有 bwrap（仅 Linux）。不可用时连显式的 `fs`/`full` 也降级为
    /// `off`：宁可无隔离地跑起来，也不要让 Windows 用户因为一个同步过来的设置而完全
    /// 用不了 agent。降级是显式的返回值，不是静默吞掉。
    pub fn resolve(self, available: bool) -> (Self, bool) {
        if available {
            return match self {
                SandboxMode::Auto => (SandboxMode::Filesystem, false),
                mode => (mode, false),
            };
        }
        match self {
            SandboxMode::Off => (SandboxMode::Off, false),
            _ => (SandboxMode::Off, true),
        }
    }
}

/// 沙盒可用性 = 平台是 Linux **且** PATH 里有可用的 bwrap。
///
/// 平台门控抽成参数化纯函数，是为了能在 Linux CI 上把「macOS/Windows 上就算装了
/// bwrap 也不算可用」这条钉住：bwrap 及其参数（`--ro-bind` / `--unshare-net` /
/// `--setenv`）都是 Linux-only，误判为可用会跳过降级、把 agent 直接起不来。
fn sandbox_supported_on(os: &str, bwrap_found: bool) -> bool {
    os == "linux" && bwrap_found
}

/// 沙盒能力探测。
pub fn sandbox_available() -> bool {
    sandbox_supported_on(std::env::consts::OS, bwrap_available())
}

/// PATH 里有没有能跑起来的 bwrap。
fn bwrap_available() -> bool {
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

/// 只暴露 agent 启动/认证所需配置。工作副本之外的 HOME 内容（SSH 密钥、浏览器、
/// 云厂商凭据等）默认不可见；新增 agent 若确有配置需求，应在这里显式加入。
const AGENT_HOME_PATHS: &[&str] = &[
    ".claude",
    ".codex",
    ".config/opencode",
    ".config/gemini",
    ".config/qwen",
    ".config/qwen-code",
    ".config/kimi",
    ".config/goose",
    ".config/github-copilot",
    ".gitconfig",
];

fn isolated_home_args(home: &Path) -> Vec<String> {
    let isolated = "/tmp/greywork-home";
    let mut args = vec![
        "--dir".to_string(),
        isolated.to_string(),
        "--dir".to_string(),
        format!("{isolated}/.config"),
        "--setenv".to_string(),
        "HOME".to_string(),
        isolated.to_string(),
    ];
    for relative in AGENT_HOME_PATHS {
        let source = home.join(relative);
        if !source.exists() {
            continue;
        }
        let target = format!("{isolated}/{relative}");
        if let Some(parent) = Path::new(&target).parent() {
            if parent != Path::new(isolated) && parent != Path::new(&format!("{isolated}/.config"))
            {
                args.extend(["--dir".to_string(), parent.to_string_lossy().into_owned()]);
            }
        }
        args.extend([
            "--ro-bind".to_string(),
            source.to_string_lossy().into_owned(),
            target,
        ]);
    }
    args
}

/// 将原始 agent 命令包裹进 bwrap 沙盒，返回 JSON 配置串（AcpAgent::from_str 可解析）。
/// workspace 必须是已存在目录；home 仅用于查找白名单中的 Agent 配置路径。
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
        args.extend(isolated_home_args(home));
    }
    let ws = workspace.to_string_lossy().into_owned();
    args.extend(["--bind".to_string(), ws.clone(), ws]);
    if mode == SandboxMode::Filesystem {
        args.push("--unshare-net".to_string());
    }

    // 原始命令经白名单校验后展开成 bwrap 的 `--` 参数。
    // 首 token 用 split_first_token 拆（尊重引号）：带空格的绝对路径
    // （如 `/home/u/my tools/bin/opencode`）用 split_whitespace 会被拆成两段。
    // 其余参数仍按空白拆 —— 命令已过 validate_spawn_command，无 shell 元字符。
    let (program, rest) = crate::process_guard::split_first_token(agent_cmd);
    args.push("--".to_string());
    args.push(program.to_string());
    args.extend(rest.split_whitespace().map(|token| token.to_string()));

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
    fn sandbox_mode_parse_rejects_unknown_values() {
        assert_eq!(SandboxMode::parse(None).unwrap(), SandboxMode::Auto);
        assert_eq!(SandboxMode::parse(Some("auto")).unwrap(), SandboxMode::Auto);
        assert_eq!(SandboxMode::parse(Some("off")).unwrap(), SandboxMode::Off);
        assert_eq!(
            SandboxMode::parse(Some("fs")).unwrap(),
            SandboxMode::Filesystem
        );
        assert_eq!(SandboxMode::parse(Some("full")).unwrap(), SandboxMode::Full);
        assert!(SandboxMode::parse(Some("yolo")).is_err());
        assert!(SandboxMode::parse(Some("FS")).is_err());
        assert_eq!(
            SandboxMode::Auto.resolve(true),
            (SandboxMode::Filesystem, false)
        );
        assert_eq!(SandboxMode::Auto.resolve(false), (SandboxMode::Off, true));
    }

    /// 平台门控：bwrap 是 Linux-only，macOS 上 brew 装了它也不能算「沙盒可用」——
    /// 否则会跳过降级、产出 bwrap 专属参数、agent 直接起不来。
    #[test]
    fn sandbox_is_available_only_on_linux_with_bwrap() {
        assert!(sandbox_supported_on("linux", true));
        assert!(!sandbox_supported_on("linux", false));
        assert!(!sandbox_supported_on("macos", true));
        assert!(!sandbox_supported_on("windows", true));
        assert!(!sandbox_supported_on("freebsd", true));
    }

    /// 非 Linux（无 bwrap）上显式选 fs/full 也要降级为 off：让 agent 起得来，
    /// 而不是因为一个同步过来的设置直接报错。
    #[test]
    fn explicit_modes_degrade_when_sandbox_is_unavailable() {
        assert_eq!(
            SandboxMode::Filesystem.resolve(false),
            (SandboxMode::Off, true)
        );
        assert_eq!(SandboxMode::Full.resolve(false), (SandboxMode::Off, true));
        // 本来就是 off：不算降级，也不该告警
        assert_eq!(SandboxMode::Off.resolve(false), (SandboxMode::Off, false));
        // bwrap 可用时显式档位原样保留
        assert_eq!(
            SandboxMode::Filesystem.resolve(true),
            (SandboxMode::Filesystem, false)
        );
        assert_eq!(SandboxMode::Full.resolve(true), (SandboxMode::Full, false));
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
    fn wrap_mounts_only_known_agent_config_under_isolated_home() {
        let root = std::env::temp_dir().join("greywork-sandbox-home");
        let home = root.join("home");
        let workspace = root.join("workspace");
        std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
        std::fs::create_dir_all(home.join("Documents")).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        let config = wrap_command(
            SandboxMode::Filesystem,
            &workspace,
            Some(&home),
            "opencode acp",
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&config).unwrap();
        let joined = parsed["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(joined.contains(&"HOME"));
        assert!(joined.contains(&"/tmp/greywork-home"));
        assert!(joined.contains(&"/tmp/greywork-home/.config/opencode"));
        assert!(!joined.contains(&home.to_str().unwrap()));
        assert!(!joined.iter().any(|arg| arg.ends_with("Documents")));
        std::fs::remove_dir_all(root).unwrap();
    }

    /// 带空格的绝对路径必须整体作为一个 argv 元素：`split_whitespace` 会把它拆成两段，
    /// bwrap 就找不到程序了。
    #[test]
    fn wrap_keeps_quoted_program_with_spaces_as_one_token() {
        let workspace = std::env::temp_dir().join("greywork-sandbox-ws-quoted");
        std::fs::create_dir_all(&workspace).unwrap();
        let config = wrap_command(
            SandboxMode::Full,
            &workspace,
            None,
            "\"/home/u/my tools/bin/opencode\" acp",
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&config).unwrap();
        let joined = parsed["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<Vec<_>>();
        let sep = joined.iter().position(|arg| *arg == "--").unwrap();
        assert_eq!(
            &joined[sep + 1..],
            &["/home/u/my tools/bin/opencode", "acp"]
        );
        std::fs::remove_dir_all(&workspace).unwrap();
    }

    #[test]
    fn wrap_rejects_missing_workspace() {
        let ghost = std::env::temp_dir().join("greywork-sandbox-ghost");
        assert!(wrap_command(SandboxMode::Filesystem, &ghost, None, "opencode acp").is_err());
    }
}
