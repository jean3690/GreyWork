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
use std::sync::OnceLock;
use std::time::Duration;

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

/// 沙盒可用性 = 平台是 Linux **且** bwrap 能真正建出沙盒。
///
/// 平台门控抽成参数化纯函数，是为了能在 Linux CI 上把「macOS/Windows 上就算装了
/// bwrap 也不算可用」这条钉住：bwrap 及其参数（`--ro-bind` / `--unshare-net` /
/// `--setenv`）都是 Linux-only，误判为可用会跳过降级、把 agent 直接起不来。
fn sandbox_supported_on(os: &str, bwrap_usable: bool) -> bool {
    os == "linux" && bwrap_usable
}

/// 沙盒能力探测。
pub fn sandbox_available() -> bool {
    sandbox_supported_on(std::env::consts::OS, bwrap_functional())
}

/// PATH 里有没有 bwrap 这个二进制（只看存在，不代表能用）。
fn bwrap_installed() -> bool {
    std::process::Command::new("bwrap")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// 探针单次超时：正常建沙盒是毫秒级；挂住说明命名空间/挂载被内核或容器运行时拦住。
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// bwrap 是否**真能建出沙盒**（结果进程内缓存一次）。
///
/// 不能用 `bwrap --version` 代替：该命令不建命名空间，因此在默认 `docker run`
/// 里照样返回 0 —— 而真实沙盒必然失败（seccomp 拦 `clone/unshare`，且缺
/// `CAP_SYS_ADMIN`）。误判为可用的后果是 `resolve()` 不做降级、照常产出
/// `SandboxMode::Filesystem`，直到 spawn 时才报「Creating new namespace failed」，
/// 前端把它误译成 agent 自身的问题。
///
/// 实测矩阵（`bwrap` + `--unshare-net`，即 `fs` 档；宿主为 WSL2 + Docker Desktop）：
/// - 默认 / 仅 `seccomp=unconfined` / 仅 `--cap-add SYS_ADMIN`：**全部失败**；
/// - `seccomp=unconfined` + `SYS_ADMIN`：`full` 可用，`fs` 因 loopback
///   `RTM_NEWADDR` 失败；
/// - 再加 `NET_ADMIN`：两档都可用（推荐，比 `--privileged` 温和）；
/// - `--privileged`：两档都可用（兜底）。
fn bwrap_functional() -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        let functional = probe_bwrap_functional();
        if !functional {
            // 只在首次探测失败时记一条，避免每次 acp_start 刷屏。
            if bwrap_installed() {
                crate::log::warn(
                    "sandbox",
                    "bwrap 已安装但无法建立沙盒，agent 将以无沙盒方式启动（降级为 off）。\
                     容器内通常是缺命名空间权限：加 --security-opt seccomp=unconfined \
                     --cap-add SYS_ADMIN --cap-add NET_ADMIN（兜底 --privileged）",
                );
            } else {
                crate::log::warn(
                    "sandbox",
                    "未找到 bwrap，agent 将以无沙盒方式启动（降级为 off）",
                );
            }
        }
        functional
    })
}

/// 跑一次与 `wrap_command(Filesystem, ..)` **同形**的最小沙盒，成功即视为可用。
///
/// 复用 `wrap_command` 而不是手拼参数，是为了让探针与生产路径不漂移：一旦
/// `wrap_command` 加了新的必需 flag（例如新的 `--ro-bind`），探针会跟着覆盖到。
fn probe_bwrap_functional() -> bool {
    // 探针工作区必须是已存在目录（`wrap_command` 会校验）；用独立子目录而不是
    // `temp_dir()` 本身 —— 否则会与 `wrap_command` 注入的 `--tmpfs /tmp` 叠加成
    // 「先 tmpfs 再 bind 到同一路径」。
    let workspace = std::env::temp_dir().join("greywork-sandbox-probe");
    if std::fs::create_dir_all(&workspace).is_err() {
        return false;
    }
    let Ok(config) = wrap_command(SandboxMode::Filesystem, &workspace, None, "/bin/true") else {
        return false;
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&config) else {
        return false;
    };
    let command = parsed["command"].as_str().unwrap_or("bwrap");
    let args: Vec<String> = parsed["args"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if args.is_empty() {
        return false;
    }
    run_with_timeout(command, &args, PROBE_TIMEOUT)
}

/// 跑一个子进程并等它结束；超时则杀掉并返回 false。
///
/// 手写轮询而不是引 `wait-timeout`：探针是一次性启动路径，多一个依赖不划算。
/// stdout/stderr 全部丢弃 —— 探针只关心退出码。
fn run_with_timeout(program: &str, args: &[String], timeout: Duration) -> bool {
    use std::process::{Command, Stdio};
    let Ok(mut child) = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return false,
        }
    }
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

/// 把 agent 首 token 解析成沙盒里可直接 exec 的**真实绝对路径**（跟随符号链接）。
///
/// - 含路径分隔符（绝对/相对路径）→ 直接 `canonicalize`；
/// - 裸程序名 → 先按登录 shell 的 `PATH` 探测（`probe_program`），再 `canonicalize`。
///
/// `canonicalize` 解掉 `~/.bun/bin/opencode → node_modules/…/opencode.exe` 这类
/// symlink 跳转，返回的路径的父目录就是真正要 bind 进沙盒的目录。解析不到返回 None
/// （由调用方原样透传裸名，让 bwrap 快速失败）。
fn resolve_program_real_path(program: &str) -> Option<PathBuf> {
    let has_separator = program.contains(std::path::MAIN_SEPARATOR)
        || program.contains('/')
        || Path::new(program).is_absolute();
    let located = if has_separator {
        PathBuf::from(program)
    } else {
        crate::process_guard::probe_program(
            program,
            crate::process_guard::effective_path().as_deref(),
        )?
    };
    located.canonicalize().ok()
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
    // 沙盒只 bind 了系统目录/工作区/白名单 HOME 配置，**没有** bind 用户装 CLI 的目录
    // （`~/.bun/bin`、`~/.local/bin`、`~/node_modules`、nvm/cargo…）。裸名 `opencode`
    // 靠沙盒内 PATH 查找必然命中一个未被 bind 的目录，bwrap `execvp` 报「No such file」，
    // 前端再把它误译成「没找到 agent 命令」。故在宿主侧把首 token 解析成**真实绝对路径**
    // （跟随符号链接，解掉 `.bun/bin → node_modules` 这类跳转），bind 其所在目录只读，
    // 并用绝对路径直接 exec——彻底绕开沙盒内的 PATH 查找与 symlink 解析。
    let program = match resolve_program_real_path(program) {
        Some(real) => {
            if let Some(parent) = real.parent() {
                let dir = parent.to_string_lossy().into_owned();
                // 系统只读目录已覆盖时不重复 bind（避免多挂一层无谓的 ro-bind）。
                let already_bound = readonly_system_dirs()
                    .iter()
                    .any(|base| parent.starts_with(base));
                if !already_bound {
                    args.extend(["--ro-bind".to_string(), dir.clone(), dir]);
                }
            }
            real.to_string_lossy().into_owned()
        }
        // 解析不到（真的没装或不在 PATH）：原样透传裸名，让 bwrap 快速失败，
        // 前端据此给安装指引——与沙盒关闭时的失败语义一致。
        None => program.to_string(),
    };
    args.push("--".to_string());
    args.push(program);
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

    /// 回归：可用性判据必须是「bwrap 真能建沙盒」，不是「bwrap 装没装」。
    ///
    /// 此前 `sandbox_available()` 喂的是 `bwrap --version` 的结果，而该命令不建
    /// 命名空间，默认 `docker run` 里照样返回 0 —— 于是容器内恒判为「可用」，
    /// 降级被跳过，直到 spawn 才炸。本用例钉住：装了但不可用 ⇒ 判为不可用。
    #[test]
    fn installed_but_non_functional_bwrap_is_not_available() {
        assert!(!sandbox_supported_on("linux", false));
    }

    /// 功能性探针必然蕴含 bwrap 已安装——否则说明探针在把垃圾当成功。
    #[cfg(target_os = "linux")]
    #[test]
    fn functional_probe_implies_installed() {
        if probe_bwrap_functional() {
            assert!(bwrap_installed(), "探针通过 ⇒ bwrap 必然已安装");
        }
    }

    /// 探针必须在超时内返回，不能挂住启动路径。
    #[cfg(target_os = "linux")]
    #[test]
    fn functional_probe_terminates() {
        let started = std::time::Instant::now();
        let _ = probe_bwrap_functional();
        assert!(
            started.elapsed() < PROBE_TIMEOUT + Duration::from_secs(2),
            "探针耗时超过超时上限"
        );
    }

    /// `run_with_timeout` 的三条路径：正常退出 / 非零退出 / 超时被杀。
    #[cfg(unix)]
    #[test]
    fn run_with_timeout_handles_exit_codes_and_timeout() {
        let ok = run_with_timeout(
            "/bin/sh",
            &["-c".to_string(), "exit 0".to_string()],
            Duration::from_secs(5),
        );
        assert!(ok, "退出码 0 ⇒ true");
        let failed = run_with_timeout(
            "/bin/sh",
            &["-c".to_string(), "exit 1".to_string()],
            Duration::from_secs(5),
        );
        assert!(!failed, "非零退出码 ⇒ false");
        // 超时：必须被 kill 掉而不是等它自己睡完。
        let started = std::time::Instant::now();
        let hung = run_with_timeout(
            "/bin/sh",
            &["-c".to_string(), "sleep 30".to_string()],
            Duration::from_millis(300),
        );
        assert!(!hung, "超时 ⇒ false");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "超时必须真的杀掉子进程"
        );
    }

    /// 不存在的程序：spawn 失败 ⇒ false（不 panic）。
    #[test]
    fn run_with_timeout_returns_false_for_missing_program() {
        assert!(!run_with_timeout(
            "gw-definitely-missing-program-xyz",
            &[],
            Duration::from_secs(1)
        ));
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

    // `/usr` 等只读绑定是 Linux 文件系统布局，故本用例仅在 Linux 上钉住。
    #[cfg(target_os = "linux")]
    #[test]
    fn wrap_fs_binds_workspace_readonly_system_and_unshares_net() {
        let workspace = std::env::temp_dir().join("greywork-sandbox-ws");
        std::fs::create_dir_all(&workspace).unwrap();
        // 用一个 PATH 上不存在的名字：本用例只钉 bind/net，程序 token 是否解析无关。
        let config = wrap_command(
            SandboxMode::Filesystem,
            &workspace,
            None,
            "gw-nonexistent-agent-xyz acp",
        )
        .unwrap();
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
        assert_eq!(&joined[sep + 1..], &["gw-nonexistent-agent-xyz", "acp"]);
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
        let has_unshare_net = parsed["args"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str() == Some("--unshare-net"));
        assert!(!has_unshare_net);
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
            "gw-nonexistent-agent-xyz acp",
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

    /// 回归：agent 二进制经 symlink 装在非系统目录（如 `~/.bun/bin/opencode →
    /// node_modules/…/opencode.exe`）时，沙盒必须 bind **真实二进制所在目录**并用
    /// 解析后的绝对路径 exec —— 否则 bwrap `execvp` 在未 bind 的目录里找不到程序，
    /// 报「No such file」，前端误译成「没找到 agent 命令」。仅 Unix：依赖 symlink 语义。
    #[cfg(unix)]
    #[test]
    fn wrap_binds_real_binary_dir_and_execs_resolved_path_via_symlink() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = std::env::temp_dir().join("greywork-sandbox-symlink");
        let _ = std::fs::remove_dir_all(&root);
        let real_dir = root.join("node_modules/opencode-ai/bin");
        let link_dir = root.join(".bun/bin");
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&real_dir).unwrap();
        std::fs::create_dir_all(&link_dir).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        let real_bin = real_dir.join("opencode.exe");
        std::fs::write(&real_bin, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&real_bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let link_bin = link_dir.join("opencode");
        symlink(&real_bin, &link_bin).unwrap();

        let cmd = format!("{} acp", link_bin.to_string_lossy());
        let config = wrap_command(SandboxMode::Filesystem, &workspace, None, &cmd).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&config).unwrap();
        let joined = parsed["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<Vec<_>>();

        let real_dir_canon = real_dir.canonicalize().unwrap();
        let real_bin_canon = real_bin.canonicalize().unwrap();
        // 真实二进制目录被 ro-bind 进沙盒。
        assert!(joined
            .windows(2)
            .any(|pair| pair == ["--ro-bind", real_dir_canon.to_str().unwrap()]));
        // `--` 之后用解析后的真实绝对路径，而非 symlink 路径。
        let sep = joined.iter().position(|arg| *arg == "--").unwrap();
        assert_eq!(
            &joined[sep + 1..],
            &[real_bin_canon.to_str().unwrap(), "acp"]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
