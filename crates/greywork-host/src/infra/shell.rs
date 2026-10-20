//! 终端命令运行器：把一条用户命令交给登录 shell 跑完，回收合并后的输出。
//!
//! 与 [`super::process_guard`] 的 `validate_spawn_command` 是**两套**语义，刻意不共用：
//! 后者把 agent / MCP 的启动面冻结成白名单 + 拒 shell 元字符；这里恰恰是「用户显式要跑
//! 一条 shell 命令」，管道与元字符就是功能本身。安全边界因此不在本模块，而在**谁能调用
//! 它**：`shell_run` 在服务端策略里属 `TRUSTED_HOST_ONLY`（见 `apps/server/src/policy.rs`）
//! —— 只有「客户端与服务端同机且受信」（Electron 壳 / 本地宿主）才放行，网络暴露的部署
//! 一律 403。
//!
//! 非交互：stdin 接空设备、有超时与输出上限。交互式 TUI（vim / top）不适用 —— 要那种能力
//! 得换 PTY，不是本模块的形态。

use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};

use super::process_guard;
use super::workspace_fs::WorkspaceFsAccess;

/// 默认超时（2 分钟）：够跑一次构建/测试的起手式，又不至于把 UI 卡在一条挂死的命令上。
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
/// 超时下限：给 0 / 极小值兜底，避免「没超时就直接杀」。
const MIN_TIMEOUT_MS: u64 = 1_000;
/// 超时上限（15 分钟）：长构建仍可调，但要有顶。
const MAX_TIMEOUT_MS: u64 = 900_000;
/// 合并输出的字节上限（256 KiB）：超出部分丢弃并标记 `truncated`，避免一条 `yes` 撑爆内存。
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

/// `shell_run` 入参（与前端扁平 camelCase 对齐）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunArgs {
    /// 要执行的命令（交给登录 shell，支持管道 / 重定向 / 元字符）。
    pub command: String,
    /// 工作目录：显式给出时必须是**已授权**的既有路径（走 `resolve_existing`）；
    /// 缺省用宿主默认根。
    #[serde(default)]
    pub cwd: Option<String>,
    /// 超时（毫秒）：缺省 [`DEFAULT_TIMEOUT_MS`]，夹在 `[MIN_TIMEOUT_MS, MAX_TIMEOUT_MS]`。
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// `shell_run` 结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    /// stdout 与 stderr 合并后的文本（先 stdout 后 stderr，UTF-8 lossy）。
    pub output: String,
    /// 退出码；被信号杀掉时为 `None`（Unix）。
    pub exit_code: Option<i32>,
    /// 实际耗时（毫秒）。
    pub duration_ms: u64,
    /// 输出是否因超过上限被截断。
    pub truncated: bool,
    /// 是否超时被杀（此时输出为空）。
    pub timed_out: bool,
}

/// 执行一条命令并回收输出。
///
/// `cwd` 显式给出时必须是**已授权**的既有路径（走 `resolve_existing`）；否则用默认根。
/// 这让终端天然落在用户绑定进来的工作区里，又不会因前端传了个任意路径就绕过授权面。
pub async fn run(access: &WorkspaceFsAccess, args: RunArgs) -> Result<RunResult, String> {
    let command = args.command.trim();
    if command.is_empty() {
        return Err("命令不能为空".to_string());
    }
    let cwd = match args
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
    {
        Some(raw) => access.resolve_existing(raw)?,
        None => access.default_root().to_path_buf(),
    };
    let timeout = Duration::from_millis(
        args.timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    );

    let mut builder = command_builder(command);
    builder
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // GUI 启动时继承的 PATH 可能残缺（macOS 的 launchd / Linux 的 .desktop），显式注入登录
    // shell 解析出的 PATH，`nvm` / `homebrew` 装的工具才找得到。
    if let Some((key, value)) = process_guard::path_env() {
        builder.env(key, value);
    }
    process_guard::isolate_process_group(&mut builder);
    process_guard::hide_console_tokio(&mut builder);

    let started = Instant::now();
    let mut child = builder
        .spawn()
        .map_err(|error| format!("启动命令失败: {error}"))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let collected = tokio::time::timeout(timeout, collect(stdout, stderr)).await;
    let (stdout_bytes, stderr_bytes, truncated, timed_out) = match collected {
        Ok((out, err, truncated)) => (out, err, truncated, false),
        // 超时：先收整棵进程树（`sh -lc` 下真正干活的常是子进程），再回收直接子进程。
        Err(_) => {
            if let Some(pid) = pid {
                process_guard::kill_process_tree(pid);
            }
            let _ = child.kill().await;
            (Vec::new(), Vec::new(), false, true)
        }
    };
    let status = child
        .wait()
        .await
        .map_err(|error| format!("回收命令进程失败: {error}"))?;

    Ok(RunResult {
        output: merge_streams(&stdout_bytes, &stderr_bytes),
        exit_code: status.code(),
        duration_ms: started.elapsed().as_millis() as u64,
        truncated,
        timed_out,
    })
}

/// 平台启动形态：unix `$SHELL -lc <command>`，Windows `cmd /C <command>`。
///
/// `-l`（login）让 rc 里的 PATH 生效；`-c` 承载命令本身。
fn command_builder(command: &str) -> tokio::process::Command {
    #[cfg(unix)]
    {
        let mut builder = tokio::process::Command::new(process_guard::user_shell());
        builder.arg("-lc").arg(command);
        builder
    }
    #[cfg(not(unix))]
    {
        let mut builder = tokio::process::Command::new("cmd");
        builder.arg("/C").arg(command);
        builder
    }
}

/// 并发读干 stdout / stderr，各自截到上限（到顶后继续读但丢弃，避免子进程写满管道阻塞）。
async fn collect(
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
) -> (Vec<u8>, Vec<u8>, bool) {
    let (out, err) = tokio::join!(read_capped(stdout), read_capped(stderr));
    (out.0, err.0, out.1 || err.1)
}

async fn read_capped<R: AsyncRead + Unpin>(reader: Option<R>) -> (Vec<u8>, bool) {
    let Some(mut reader) = reader else {
        return (Vec::new(), false);
    };
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(read) => {
                let remaining = MAX_OUTPUT_BYTES.saturating_sub(buffer.len());
                let take = read.min(remaining);
                buffer.extend_from_slice(&chunk[..take]);
                if take < read {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    (buffer, truncated)
}

/// stdout 在前、stderr 在后拼接（非 PTY 下两股流没有可靠的交织信息，不假装交错）。
fn merge_streams(stdout: &[u8], stderr: &[u8]) -> String {
    let mut text = String::from_utf8_lossy(stdout).into_owned();
    if !stderr.is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&String::from_utf8_lossy(stderr));
    }
    text
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use crate::workspace_fs::WorkspaceFsAccess;

    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时间早于 UNIX 纪元")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("greywork-shell-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn access(tag: &str) -> WorkspaceFsAccess {
        let root = temp_dir(tag);
        WorkspaceFsAccess::new(&root, root.join("access.json")).expect("构造授权面")
    }

    fn args(command: &str) -> RunArgs {
        RunArgs {
            command: command.to_string(),
            cwd: None,
            timeout_ms: None,
        }
    }

    #[tokio::test]
    async fn rejects_empty_command() {
        let error = run(&access("empty"), args("   ")).await.unwrap_err();
        assert!(error.contains("不能为空"), "实际: {error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn merges_stdout_before_stderr_and_reports_exit_code() {
        // `printf` 是 shell 内建，`-lc` 下必然存在；退出码由 `exit 3` 直接给定。
        let result = run(
            &access("merge"),
            args("printf out; printf err 1>&2; exit 3"),
        )
        .await
        .expect("执行命令");
        assert_eq!(result.exit_code, Some(3));
        assert!(!result.timed_out);
        assert!(!result.truncated);
        let out_at = result.output.find("out").expect("含 stdout");
        let err_at = result.output.find("err").expect("含 stderr");
        assert!(out_at < err_at, "stdout 应先于 stderr: {:?}", result.output);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_the_process_tree_and_discards_output() {
        let mut run_args = args("printf early; sleep 5");
        run_args.timeout_ms = Some(MIN_TIMEOUT_MS);
        let result = run(&access("timeout"), run_args).await.expect("执行命令");
        assert!(result.timed_out, "应被超时杀掉");
        assert!(
            result.output.is_empty(),
            "超时输出应丢弃: {:?}",
            result.output
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn caps_output_and_flags_truncation() {
        // 400000 字节 > MAX_OUTPUT_BYTES（256 KiB）。
        let result = run(&access("truncate"), args("yes | head -c 400000"))
            .await
            .expect("执行命令");
        assert!(result.truncated, "超过上限应标记 truncated");
        assert!(result.output.len() <= MAX_OUTPUT_BYTES);
    }
}
