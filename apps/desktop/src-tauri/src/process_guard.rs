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

#[cfg(unix)]
use std::ffi::OsString;
#[cfg(unix)]
use std::sync::OnceLock;

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
    // Windows 上会被 `shell_command` 套进 `cmd /C` 的命令（`.cmd`/`.bat` 垫片）额外拒 `%`：
    // cmd.exe 会做变量展开，把宿主环境变量带进 agent 的 argv。
    if let Some(found) = cmd_wrap_metachar(trimmed, batch_program(basename).is_some()) {
        return Err(format!(
            "spawn command contains character {found:?} that cmd.exe would expand"
        ));
    }
    Ok(trimmed.to_string())
}

/// Windows `cmd /C` 包装路径**专属**的元字符。
///
/// 只有会落到 `cmd /C` 的命令才需要拦（`shell_command` 的包装条件 = `batch_program`
/// 命中 `.cmd`/`.bat` 垫片）：cmd.exe 会对 `%VAR%` 做变量展开，把宿主环境变量带进
/// agent 的 argv。刻意**不**并进 `SHELL_META_CHARS`：`%` 在 POSIX 上是合法字符，
/// 并进去会把 Linux/macOS 上本来能用的命令一并拒掉，改动面没必要。
pub const CMD_WRAP_META_CHARS: &[char] = &['%'];

/// `command` 里第一个会被 cmd.exe 展开的字符；不包装时恒为 `None`。
///
/// 抽成参数化纯函数，好在 Linux CI 上把规则钉住 —— 真实的 `will_wrap` 依赖 Windows 的
/// PATH + PATHEXT 探测结果，在 CI 的 Linux job 上拿不到。
fn cmd_wrap_metachar(command: &str, will_wrap: bool) -> Option<char> {
    if !will_wrap {
        return None;
    }
    command.chars().find(|c| CMD_WRAP_META_CHARS.contains(c))
}

/// 在给定 PATH 值里找可执行文件；纯文件系统命中，不起进程。
pub fn probe_program(program: &str, path_value: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let value = path_value
        .map(|v| v.to_os_string())
        .or_else(effective_path)?;
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
pub(crate) fn split_first_token(command: &str) -> (&str, &str) {
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
    let mut command = std::process::Command::new("taskkill");
    command
        .args(["/PID", pid.as_str(), "/T", "/F"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    hide_console_std(&mut command);
    let _ = command.status();
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

/* ===== Windows 控制台窗口抑制 ===== */

/// Windows `CREATE_NO_WINDOW`（`0x0800_0000`）：不给控制台程序分配新的控制台窗口。
///
/// `windows-sys` 不是本 crate 的直接依赖，所以写死字面量。抽成函数是为了让**任何**
/// 平台都能把这个值钉住 —— `#[cfg(any(windows, test))]` 是因为非 Windows 的非测试
/// 构建里它没有调用点，留着会被判 dead_code。
#[cfg(any(windows, test))]
const fn console_creation_flags() -> Option<u32> {
    if cfg!(windows) {
        Some(0x0800_0000)
    } else {
        None
    }
}

/// 让 `std::process::Command` 在 Windows 上不闪控制台窗口；其他平台空实现。
///
/// 打包版是 GUI 子系统程序（自身没有控制台），spawn `taskkill` / `git` 这类控制台程序
/// 时 Windows 会新分配一个控制台窗口 —— 现象就是黑框一闪。ACP 路径没这问题，因为
/// `agent-client-protocol` 内部已经设了 `CREATE_NO_WINDOW`。
pub fn hide_console_std(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Some(flags) = console_creation_flags() {
            command.creation_flags(flags);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// `tokio::process::Command` 版本；语义同 `hide_console_std`。
pub fn hide_console_tokio(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        if let Some(flags) = console_creation_flags() {
            command.creation_flags(flags);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/* ===== GUI 启动时的 PATH 兜底（Unix） ===== */

/// 登录 shell 解析出的 PATH；`init_login_path` 里设一次，之后只读。
///
/// 刻意**不用** `std::env::set_var`：Tauri 运行时已经起了线程，Unix 上 `setenv` 与
/// 子进程的 `getenv` 并发是数据竞争（Rust 也已把 `set_var` 标成 unsafe）。需要的地方
/// 显式取用 —— `effective_path()`（探测）或 `path_env()`（spawn 时注入）。
#[cfg(unix)]
static LOGIN_PATH: OnceLock<OsString> = OnceLock::new();

/// 解析登录 shell 的超时上限；到点强杀，绝不拖住启动。
#[cfg(unix)]
const LOGIN_PATH_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);
/// 包住 PATH 输出的标记，用来忽略 rc 文件的横幅（横幅在标记之前）。
#[cfg(unix)]
const PATH_MARKER_BEGIN: &str = "__GREYWORK_PATH_BEGIN__";
#[cfg(unix)]
const PATH_MARKER_END: &str = "__GREYWORK_PATH_END__";

/// 解析登录 shell 的 PATH 并缓存（`lib.rs` 的 setup 里调一次，**立即返回**）。
///
/// 打包版从 Finder/Dock 或 `.desktop` 启动时继承的是极简 PATH（macOS 上是 launchd 的
/// `/usr/bin:/bin:/usr/sbin:/sbin`），Homebrew / nvm 装的 `npx`、`node`、`opencode`
/// 全都探测不到 —— 设置页显示「未安装」，agent 起不来。
///
/// 解析结果 = 登录 shell 的 PATH **+** 继承的 PATH（按顺序去重），所以不可能丢掉继承值。
/// 解析失败（无 shell / 超时 / 输出里没有标记）就保持未初始化，
/// `effective_path()` 退回继承的 PATH —— 功能退化到本函数存在之前的行为。
///
/// 跑在后台线程上：解析要起一次登录 shell（实测 ~1.2s，rc 里装了 nvm 之类更慢），而
/// `setup` 发生在 webview 加载与窗口 `show()` 之前 —— 同步等会让**每一次**启动都变慢。
/// 代价是启动后约 1s 内 `effective_path()` 仍返回继承的 PATH，此时立刻点「启动 agent」
/// 会失败一次（可重试），换来的是启动路径零阻塞。
pub fn init_login_path() {
    // drop 掉 JoinHandle 即分离线程：解析完自己填 OnceLock，没人需要 join。
    #[cfg(unix)]
    let _ = std::thread::spawn(|| {
        let inherited = std::env::var_os("PATH").unwrap_or_default();
        let merged = match resolve_login_path() {
            Some(login) => merge_paths(&login, &inherited.to_string_lossy()),
            None => inherited.to_string_lossy().into_owned(),
        };
        if !merged.is_empty() {
            let _ = LOGIN_PATH.set(OsString::from(merged));
        }
    });
}

/// 探测/启动子进程时该用的 PATH：登录 shell 解析结果优先，否则继承的 PATH。
pub fn effective_path() -> Option<OsString> {
    #[cfg(unix)]
    {
        if let Some(value) = LOGIN_PATH.get() {
            return Some(value.clone());
        }
    }
    std::env::var_os("PATH")
}

/// 需要把 PATH **显式注入**子进程环境时返回 `("PATH", value)`；无需注入则 `None`。
///
/// 只覆盖 GUI 启动那种「继承的 PATH 是残缺的」情形：只改探测不够，`npx`/`node` 自己
/// 也要按 PATH 找下一跳。Windows 的 PATH 来自注册表、本来就完整，故恒为 `None`。
pub fn path_env() -> Option<(String, String)> {
    #[cfg(unix)]
    {
        LOGIN_PATH
            .get()
            .map(|value| ("PATH".to_string(), value.to_string_lossy().into_owned()))
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// 该用哪个 shell 跑登录脚本：`$SHELL` 可用则用，否则按常见路径兜底。
#[cfg(unix)]
fn login_shell() -> String {
    if let Some(shell) = std::env::var_os("SHELL").filter(|value| !value.is_empty()) {
        if Path::new(&shell).is_file() {
            return shell.to_string_lossy().into_owned();
        }
    }
    for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if Path::new(candidate).is_file() {
            return candidate.to_string();
        }
    }
    "/bin/sh".to_string()
}

/// 取 shell 的可执行文件名（`/bin/zsh` → `zsh`），决定用哪种 PATH 拼接语法。
#[cfg(unix)]
fn shell_basename(shell: &str) -> &str {
    shell.rsplit('/').next().unwrap_or(shell)
}

/// 登录 shell 里要跑的那行：用标记包住 PATH，好忽略 rc 的横幅输出。
///
/// fish 的 `$PATH` 是列表，得先 `string join :` 拼成冒号串。
#[cfg(unix)]
fn login_shell_script(basename: &str) -> String {
    let path_expr = if basename.eq_ignore_ascii_case("fish") {
        "(string join : $PATH)"
    } else {
        "\"$PATH\""
    };
    format!("printf '{PATH_MARKER_BEGIN}%s{PATH_MARKER_END}' {path_expr}")
}

/// 从登录 shell 的输出里取标记之间的 PATH。
///
/// 取**最后一次**出现的起始标记：rc 的横幅在真正的输出之前，即使横幅里恰好含标记
/// 字样也不会取错。缺标记或中间为空 → `None`（调用方退回继承的 PATH）。
#[cfg(unix)]
fn parse_marked_path(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let start = text.rfind(PATH_MARKER_BEGIN)? + PATH_MARKER_BEGIN.len();
    let rest = &text[start..];
    let end = rest.find(PATH_MARKER_END)?;
    let value = rest[..end].trim_matches(['\r', '\n', ' ', '\t']);
    (!value.is_empty()).then(|| value.to_string())
}

/// 合并登录 shell 与继承的 PATH，按 `:` 去重（登录的优先，保持顺序）。
///
/// 跳过空段：POSIX 里空段等价于「当前目录」，不该被带进子进程。
#[cfg(unix)]
fn merge_paths(login: &str, inherited: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<&str> = Vec::new();
    for dir in login.split(':').chain(inherited.split(':')) {
        if !dir.is_empty() && seen.insert(dir) {
            out.push(dir);
        }
    }
    out.join(":")
}

/// 起一次 `$SHELL -ilc` 取 PATH；超时或失败返回 `None`。
///
/// `-i` 是为了让 `.zshrc` / `.bashrc` 里的 PATH 设置生效（`.zprofile` 由 `-l` 覆盖），
/// 代价是与 PATH 无关的 job control 噪音 —— stderr 直接丢空。
#[cfg(unix)]
fn resolve_login_path() -> Option<String> {
    use std::io::Read as _;

    let shell = login_shell();
    let script = login_shell_script(shell_basename(&shell));
    let mut child = std::process::Command::new(&shell)
        .arg("-ilc")
        .arg(script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    let deadline = std::time::Instant::now() + LOGIN_PATH_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            // 到点仍在跑（rc 卡住）或 wait 出错：强杀后放弃，绝不拖住启动
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }

    let mut buf = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_end(&mut buf);
    }
    parse_marked_path(&buf)
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

    /// `%` 只在会经 `cmd /C` 中转时才拒：它是 cmd.exe 的变量展开符，但在 POSIX 上
    /// 完全合法，不能并进全局元字符列表。
    #[test]
    fn cmd_wrap_metachar_only_applies_to_wrapped_commands() {
        assert_eq!(cmd_wrap_metachar("npx -y pkg@%foo%", true), Some('%'));
        assert_eq!(cmd_wrap_metachar("npx -y pkg@%foo%", false), None);
        assert_eq!(cmd_wrap_metachar("npx -y pkg", true), None);

        // 全局列表里没有 `%`：POSIX 上带 `%` 的命令仍被放行
        assert!(!SHELL_META_CHARS.contains(&'%'));
        assert!(validate_spawn_command("npx -y pkg@100%", ALLOWED).is_ok());
    }

    /// 常量必须在两个平台上都钉住：Windows 上是 `CREATE_NO_WINDOW`，其他平台是「不设」。
    #[test]
    fn console_creation_flags_pins_create_no_window() {
        if cfg!(windows) {
            assert_eq!(console_creation_flags(), Some(0x0800_0000));
        } else {
            assert_eq!(console_creation_flags(), None);
        }
    }

    /// fish 的 `$PATH` 是列表，必须走 `string join :`；其余 shell 用 `"$PATH"`。
    #[cfg(unix)]
    #[test]
    fn login_shell_script_picks_fish_and_posix_path_syntax() {
        let expected =
            |expr: &str| format!("printf '{PATH_MARKER_BEGIN}%s{PATH_MARKER_END}' {expr}");
        assert_eq!(login_shell_script("zsh"), expected("\"$PATH\""));
        assert_eq!(login_shell_script("bash"), expected("\"$PATH\""));
        assert_eq!(login_shell_script("sh"), expected("\"$PATH\""));
        assert_eq!(
            login_shell_script("FISH"),
            expected("(string join : $PATH)")
        );
    }

    /// 合成输入覆盖三种现实情况：rc 横幅在前、CRLF 行尾、缺标记。
    #[cfg(unix)]
    #[test]
    fn parse_marked_path_ignores_rc_banner_and_tolerates_crlf() {
        let banner_first = format!(
            "Welcome to zsh!\r\n{PATH_MARKER_BEGIN}/opt/homebrew/bin:/usr/bin{PATH_MARKER_END}\r\n"
        );
        assert_eq!(
            parse_marked_path(banner_first.as_bytes()).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );

        // 横幅里恰好含标记字样：取最后一次出现（真正的输出在最后）
        let noisy = format!(
            "{PATH_MARKER_BEGIN}banner junk{PATH_MARKER_END}\n\
             {PATH_MARKER_BEGIN}/real/bin{PATH_MARKER_END}"
        );
        assert_eq!(
            parse_marked_path(noisy.as_bytes()).as_deref(),
            Some("/real/bin")
        );

        // 缺标记 / 标记之间为空 / 完全没有输出 → None，调用方退回继承 PATH
        assert_eq!(parse_marked_path(b"just a banner"), None);
        assert_eq!(
            parse_marked_path(format!("{PATH_MARKER_BEGIN}{PATH_MARKER_END}").as_bytes()),
            None
        );
        assert_eq!(parse_marked_path(b""), None);
    }

    /// 合并结果必须是「登录优先 + 继承不丢」，且跳过空段（POSIX 里等价于 CWD）。
    #[cfg(unix)]
    #[test]
    fn merge_paths_prefers_login_and_keeps_inherited() {
        assert_eq!(
            merge_paths("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin"),
            "/opt/homebrew/bin:/usr/bin:/bin"
        );
        assert_eq!(merge_paths("/a::/b", ":/b:/c"), "/a:/b:/c");
        assert_eq!(merge_paths("", "/bin"), "/bin");
        assert_eq!(merge_paths("/bin", ""), "/bin");
        assert_eq!(merge_paths("", ""), "");
    }

    /// 端到端跑一次真实登录 shell：shell 选择 → 脚本 → 超时 → 解析。
    ///
    /// 环境里没有可用 shell 时允许返回 `None`（那正是「不拖住启动」的退化路径），
    /// 但只要有结果就必须是像样的 PATH 且标记没泄漏进去。
    #[cfg(unix)]
    #[test]
    fn resolve_login_path_returns_plausible_value_or_none() {
        if let Some(value) = resolve_login_path() {
            assert!(!value.is_empty());
            assert!(value.contains('/'), "PATH 应由绝对目录组成，得到 {value:?}");
            assert!(
                !value.contains(PATH_MARKER_BEGIN) && !value.contains(PATH_MARKER_END),
                "标记不能泄漏进结果: {value:?}"
            );
            assert!(
                !value.split(':').any(|dir| dir.is_empty()),
                "空段（等价 CWD）不该被带出来: {value:?}"
            );
        }
    }

    /// `effective_path` 在未初始化时必须等于继承的 PATH（功能退化为旧行为）。
    #[cfg(unix)]
    #[test]
    fn effective_path_falls_back_to_inherited_env() {
        assert_eq!(
            effective_path(),
            std::env::var_os("PATH"),
            "LOGIN_PATH 未设置时应原样返回继承的 PATH"
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
