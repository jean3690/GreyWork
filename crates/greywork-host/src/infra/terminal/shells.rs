//! 可用 shell 探测：把「这台机器上能开的终端环境」列出来。
//!
//! 平台各一条路径：
//! - **Unix**：`$SHELL`（用户登录 shell，即「在电脑上打开终端」的那一个）优先，再收
//!   `/etc/shells` 里登记过的登录 shell，最后补常见路径兜底（容器里常常没有 `/etc/shells`）。
//! - **Windows**：`cmd` / `pwsh` / Windows PowerShell / Git Bash / WSL，逐个用
//!   [`process_guard::probe_program`] 在 PATH + PATHEXT 上探测，只列真的装了的。
//!
//! 探测**不起进程**（纯文件系统命中），所以列一次很便宜。渲染端只拿 `id` / `label`：
//! 选 shell 传 id，后端再按 id 反查可执行路径 —— 前端传不了任意程序，spawn 面收在
//! 本模块的候选表里。

use std::path::{Path, PathBuf};

use serde::Serialize;

#[cfg(windows)]
use crate::infra::process_guard;

/// 一个可选终端环境（宿主内部用，含可执行路径）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellOption {
    /// 稳定标识（前端按 id 选 shell，不直接传可执行路径）。
    pub id: String,
    /// 展示名。
    pub label: String,
    /// 可执行文件路径。
    pub program: PathBuf,
    /// 启动参数（如 PowerShell 的 `-NoLogo`、bash 的 `--login`）。
    pub args: Vec<String>,
}

/// 回给渲染端的 shell 元数据（不含可执行路径）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellDto {
    pub id: String,
    pub label: String,
}

/// `terminal_shells` 的返回：候选表 + 默认 id。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellCatalog {
    pub shells: Vec<ShellDto>,
    /// 默认 shell（新建标签页时预选）。本机一个都探测不到时为 `None`。
    pub default_id: Option<String>,
}

/// 探测本机可用 shell；返回顺序即展示顺序。
pub fn detect() -> Vec<ShellOption> {
    #[cfg(unix)]
    {
        unix_shells()
    }
    #[cfg(windows)]
    {
        windows_shells()
    }
    #[cfg(not(any(unix, windows)))]
    {
        Vec::new()
    }
}

/// 组装回给渲染端的目录。
pub fn catalog() -> ShellCatalog {
    let shells = detect();
    let default_id = default_id(&shells);
    ShellCatalog {
        shells: shells.iter().map(shell_dto).collect(),
        default_id,
    }
}

fn shell_dto(shell: &ShellOption) -> ShellDto {
    ShellDto {
        id: shell.id.clone(),
        label: shell.label.clone(),
    }
}

/// 默认 shell 的优先级：优先现代 PowerShell，其次 Windows PowerShell，再 cmd；
/// Unix 上恒取列表首个（即 `$SHELL` / 首个登录 shell）。
fn default_id(shells: &[ShellOption]) -> Option<String> {
    if shells.is_empty() {
        return None;
    }
    #[cfg(windows)]
    {
        for preferred in ["pwsh", "powershell", "cmd"] {
            if let Some(shell) = shells.iter().find(|shell| shell.id == preferred) {
                return Some(shell.id.clone());
            }
        }
    }
    shells.first().map(|shell| shell.id.clone())
}

/// 按 id 解析 shell；`None` 或未知 id 回落到默认 shell。
pub fn resolve(id: Option<&str>) -> Option<ShellOption> {
    let shells = detect();
    let preferred = id.and_then(|wanted| shells.iter().find(|shell| shell.id == wanted));
    if let Some(shell) = preferred {
        return Some(shell.clone());
    }
    let default = default_id(&shells)?;
    shells.into_iter().find(|shell| shell.id == default)
}

// ---------------------------------------------------------------------------
// Unix
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn unix_shells() -> Vec<ShellOption> {
    let mut out = Vec::new();

    // 1) 用户登录 shell 优先 —— 这就是「在电脑上打开终端」的那一个。
    if let Ok(shell) = std::env::var("SHELL") {
        let raw = shell.trim();
        if !raw.is_empty() {
            push_executable(&mut out, PathBuf::from(raw), vec!["-l".to_string()]);
        }
    }

    // 2) `/etc/shells` 里登记过的登录 shell（各发行版维护的有效 shell 清单）。
    if let Ok(contents) = std::fs::read_to_string("/etc/shells") {
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            push_executable(&mut out, PathBuf::from(line), vec!["-l".to_string()]);
        }
    }

    // 3) 常见路径兜底：容器 / 极简镜像里往往没有 `/etc/shells`，也没有 `$SHELL`。
    for path in [
        "/bin/bash",
        "/bin/zsh",
        "/usr/bin/fish",
        "/opt/homebrew/bin/fish",
        "/usr/bin/nu",
        "/bin/sh",
    ] {
        push_executable(&mut out, PathBuf::from(path), vec!["-l".to_string()]);
    }

    out
}

/// 存在的可执行文件才收进列表；按 canonical 路径去重（`$SHELL` 与 `/etc/shells` 常重叠）。
#[cfg(unix)]
fn push_executable(out: &mut Vec<ShellOption>, path: PathBuf, args: Vec<String>) {
    if !is_executable_file(&path) {
        return;
    }
    let canonical = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
    if out.iter().any(|shell| {
        std::fs::canonicalize(&shell.program).unwrap_or_else(|_| shell.program.clone()) == canonical
    }) {
        return;
    }
    let id = shell_id(&path);
    let label = shell_label(&id, &path);
    out.push(ShellOption {
        id,
        label,
        program: path,
        args,
    });
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(unix)]
fn shell_id(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_else(|| path.to_string_lossy().to_ascii_lowercase())
}

#[cfg(unix)]
fn shell_label(id: &str, path: &Path) -> String {
    match id {
        "bash" => "Bash".to_string(),
        "zsh" => "Zsh".to_string(),
        "fish" => "Fish".to_string(),
        "nu" => "Nushell".to_string(),
        "dash" => "Dash".to_string(),
        "sh" => "POSIX sh".to_string(),
        _ => path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| id.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn windows_shells() -> Vec<ShellOption> {
    let mut out = Vec::new();

    for (program, id, label, args) in [
        ("cmd", "cmd", "命令提示符 (cmd)", &[][..]),
        ("pwsh", "pwsh", "PowerShell", &["-NoLogo"][..]),
        (
            "powershell",
            "powershell",
            "Windows PowerShell",
            &["-NoLogo"][..],
        ),
    ] {
        push_probed(&mut out, program, id, label, args);
    }

    // Git Bash：先查常见安装位置，再从 PATH 上的 `git` 反推 `<root>\bin\bash.exe`。
    if let Some(bash) = find_git_bash() {
        push_resolved(&mut out, bash, "git-bash", "Git Bash", &["--login", "-i"]);
    }

    push_probed(&mut out, "wsl", "wsl", "WSL", &[]);
    push_probed(&mut out, "nu", "nu", "Nushell", &[]);

    out
}

/// 在 PATH + PATHEXT 上探测；命中才收。
#[cfg(windows)]
fn push_probed(out: &mut Vec<ShellOption>, program: &str, id: &str, label: &str, args: &[&str]) {
    if let Some(path) = process_guard::probe_program(program, None) {
        push_resolved(out, path, id, label, args);
    }
}

/// 按 canonical 路径去重后收进列表（id/label 由调用点显式给，不猜）。
#[cfg(windows)]
fn push_resolved(out: &mut Vec<ShellOption>, path: PathBuf, id: &str, label: &str, args: &[&str]) {
    let canonical = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
    if out.iter().any(|shell| {
        std::fs::canonicalize(&shell.program).unwrap_or_else(|_| shell.program.clone()) == canonical
    }) {
        return;
    }
    out.push(ShellOption {
        id: id.to_string(),
        label: label.to_string(),
        program: path,
        args: args.iter().map(|arg| arg.to_string()).collect(),
    });
}

/// 定位 Git for Windows 的 `bash.exe`。
#[cfg(windows)]
fn find_git_bash() -> Option<PathBuf> {
    for env in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        let Ok(base) = std::env::var(env) else {
            continue;
        };
        for rel in ["Git/bin/bash.exe", "Programs/Git/bin/bash.exe"] {
            let candidate = Path::new(&base).join(rel);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    // 从 PATH 上的 `git.exe` 反推安装根：`<root>\cmd\git.exe` → `<root>\bin\bash.exe`。
    let git = process_guard::probe_program("git", None)?;
    let root = git.parent()?.parent()?;
    for rel in ["bin/bash.exe", "usr/bin/bash.exe"] {
        let candidate = root.join(rel);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}
