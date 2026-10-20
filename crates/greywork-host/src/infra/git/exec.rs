//! 有界 git 执行：抽干管道 + 到点杀进程组。

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const GIT: &str = "git";

/// git 子命令的超时上限。
///
/// 巨型仓库（或冷缓存、网络盘）上的 `status` / `diff` 可能长时间不出结果，而渲染端的
/// `await invoke(...)` 没有超时窗口 —— 无上限就等于把「卡死」表现成永久转圈。到点整组
/// 杀进程并报错，让 UI 至少能恢复。取 30s：覆盖正常的大仓库查询，又不至于让用户白等太久。
const GIT_TIMEOUT: Duration = Duration::from_secs(30);

/// 跑一个已配置好的命令并收 stdout/stderr，超过 `timeout` 未退则整组杀进程。
///
/// **为什么不用 `.output()`**：它既没有超时窗口，也会在管道写满而调用方还没开始读时死锁
/// （`git diff` 大文件轻易超过 64KB 管道缓冲）。这里 stdout/stderr 各起一个读线程把管道
/// 抽干，主线程只轮询退出状态 —— 到点用 `kill_process_tree` 回收整组，读线程随管道关闭自然收尾。
///
/// Unix 上 spawn 前自成进程组（`process_group(0)`）：`kill_process_tree` 的契约要求 pid
/// 就是组长，否则 killpg 会 ESRCH 而静默留下残留进程。
///
/// `pub(crate)`：`infra::worktree` 跑 `.agents/prepare` 时复用同一套有界执行，
/// 免得再抄一遍「抽干管道 + 到点杀进程组」。
pub(crate) fn run_capture(
    cmd: &mut Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let program = cmd.get_program().to_string_lossy().into_owned();
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("无法启动 {program}: {error}"))?;
    let mut out_pipe = child.stdout.take().expect("stdout 已设为 piped");
    let mut err_pipe = child.stderr.take().expect("stderr 已设为 piped");
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out_pipe.read_to_end(&mut buf);
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err_pipe.read_to_end(&mut buf);
        buf
    });

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    crate::process_guard::kill_process_tree(child.id());
                    break child
                        .wait()
                        .map_err(|error| format!("等待进程退出失败: {error}"))?;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(error) => return Err(format!("等待进程退出失败: {error}")),
        }
    };

    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    if timed_out {
        return Err(format!(
            "命令超时（超过 {} 秒未返回），已中止执行",
            timeout.as_secs()
        ));
    }
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

/// 在授权根内执行 git；失败返回 stderr（去尾空白）。绝不弹出交互提示，且有超时上限。
pub(super) fn run_git(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(GIT);
    // Windows 上隐藏控制台窗口（GUI 程序 spawn 控制台程序会闪黑框）。
    // 只隐藏、不 detach：下面同步收 stdio。
    crate::process_guard::hide_console_std(&mut cmd);
    cmd.current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        // 只读操作不升级索引/引用（避免后台还挂着别的 git 时搬走锁文件）
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(["-c", "core.quotepath=false", "-c", "color.ui=never"])
        .args(args);
    let output = run_capture(&mut cmd, GIT_TIMEOUT)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr)
            .trim_end()
            .to_string();
        let stdout = String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string();
        if stderr.is_empty() {
            Err(stdout)
        } else {
            Err(stderr)
        }
    }
}
