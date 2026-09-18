//! 宿主自管的 ACP agent 进程：stdio 传输 + 进程树回收 + stderr 尾部诊断。
//!
//! 为什么不用 `AcpAgent` 自带的 `ConnectTo` 实现：它在内部 spawn 子进程并用
//! `ChildGuard` 回收，而那个守卫在 Windows 上只有 `TerminateProcess`（直接子进程）。
//! 宿主在 Windows 上必须把 `.cmd` 垫片包成 `cmd /C ...`（见
//! `process_guard::shell_command`），于是直接子进程是 `cmd.exe`，真正干活的
//! `npx → node` 是它的孙子 —— cmd 一死就被过继给系统继续跑，占着工作区与 API 额度。
//!
//! `AcpAgent::spawn_process()` 是 crate 公开的低层逃生口：返回子进程句柄与三条 stdio，
//! 并明确把回收责任交给调用方。这里据此自管进程，回收走**进程树**
//! （Windows `taskkill /T /F`、Unix `killpg`）。
//!
//! 代价：crate 在 `connect_to` 里另做了两件事 —— stderr 捕获、以及「stdout 提前 EOF 时
//! 给 stdin 写入加超时」。前者由 `drain_stderr` 补回（只留尾部，够失败诊断）；后者不补：
//! 只在 agent 半关 stdout 却仍不读 stdin 时才会挂住写入，实测面极窄，而照搬那段逻辑要
//! 复刻 crate 的整套 child-exit 竞速，得不偿失。

use std::sync::Arc;

use agent_client_protocol::{Agent, ByteStreams, Client, ConnectTo, Error as AcpError};
use futures_util::io::{AsyncRead, AsyncWrite};
use futures_util::{AsyncBufReadExt, StreamExt};
use parking_lot::Mutex;

use crate::process_guard;

/// stderr 尾部保留上限：够看清「为什么起不来」，又不至于把错误串撑爆。
/// （crate 内部保留 64 KiB 全量，我们只服务失败诊断，取小一档。）
const STDERR_TAIL_LIMIT: usize = 4 * 1024;

/// 跨任务共享的 stderr 尾部快照；`acp_start` 失败时附在错误里。
pub type StderrTail = Arc<Mutex<String>>;

/// 已 spawn 的 agent stdio 组成的 ACP 传输层，附带按进程树回收的守卫。
pub struct AgentStdio<W, R> {
    outgoing: W,
    incoming: R,
    /// 直接子进程 pid。Unix 上它同时是进程组 id —— `AcpAgent::spawn_process` 设了
    /// `process_group(0)`，这正是 `kill_process_tree` 能整组回收的前提。
    pid: u32,
}

impl<W, R> AgentStdio<W, R> {
    pub fn new(outgoing: W, incoming: R, pid: u32) -> Self {
        Self {
            outgoing,
            incoming,
            pid,
        }
    }
}

impl<W, R> ConnectTo<Client> for AgentStdio<W, R>
where
    W: AsyncWrite + Send + 'static,
    R: AsyncRead + Send + 'static,
{
    async fn connect_to(self, client: impl ConnectTo<Agent>) -> Result<(), AcpError> {
        // 守卫与连接 future 同生共死：`acp_stop` abort 掉外层任务、或握手失败提前返回时，
        // future 被 drop，守卫随之回收整棵进程树。
        //
        // 不写成 `AgentStdio` 的 `Drop`：`self` 在这里被按字段拆走，Drop 会在拆解那一刻
        // 就触发，等于刚连上就杀进程。
        let _guard = ProcessTreeGuard(self.pid);
        let streams = ByteStreams::new(self.outgoing, self.incoming);
        ConnectTo::<Client>::connect_to(streams, client).await
    }
}

/// 析构即回收整棵进程树。
struct ProcessTreeGuard(u32);

impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        process_guard::kill_process_tree(self.0);
    }
}

/// 排空 agent stderr，返回持续更新的尾部快照。
///
/// **必须排空**：管道写满（约 64 KiB）后 agent 的 stderr 写入会阻塞，整个进程卡死。
pub fn drain_stderr(stream: impl AsyncRead + Send + 'static) -> StderrTail {
    let tail: StderrTail = Arc::new(Mutex::new(String::new()));
    let sink = tail.clone();
    tauri::async_runtime::spawn(async move {
        // 装箱换 Unpin：`lines()` 的 `next()` 要求 `Self: Unpin`。
        let mut lines = Box::pin(futures_util::io::BufReader::new(stream).lines());
        while let Some(Ok(line)) = lines.next().await {
            push_tail(&mut sink.lock(), &line);
        }
    });
    tail
}

/// 把一行并入尾部缓冲，超限时从最旧处裁掉。
/// 按字符边界裁剪：切裂多字节字符会让 `String` 直接 panic。
fn push_tail(tail: &mut String, line: &str) {
    tail.push_str(line);
    tail.push('\n');
    if tail.len() <= STDERR_TAIL_LIMIT {
        return;
    }
    let excess = tail.len() - STDERR_TAIL_LIMIT;
    let cut = (excess..=tail.len())
        .find(|index| tail.is_char_boundary(*index))
        .unwrap_or(tail.len());
    tail.replace_range(..cut, "");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 长会话下尾部缓冲不能无限增长，且必须留住**最新**的几行（诊断看的是最后吐出的东西）。
    #[test]
    fn push_tail_keeps_newest_within_limit() {
        let mut tail = String::new();
        for index in 0..500 {
            push_tail(&mut tail, &format!("line-{index}-{}", "x".repeat(64)));
        }
        assert!(tail.len() <= STDERR_TAIL_LIMIT);
        assert!(tail.ends_with(&format!("line-499-{}\n", "x".repeat(64))));
        assert!(!tail.contains("line-0-"), "最旧的行应已被裁掉");
    }

    /// 裁剪点落在多字节字符中间时不能切裂（切裂即 panic）。
    #[test]
    fn push_tail_never_splits_multibyte_characters() {
        let mut tail = String::new();
        for _ in 0..300 {
            push_tail(&mut tail, "中文字符测试");
        }
        assert!(tail.len() <= STDERR_TAIL_LIMIT);
        assert!(tail.is_char_boundary(tail.len()));
        assert!(tail
            .chars()
            .all(|c| c == '\n' || "中文字符测试".contains(c)));
    }

    /// 单行本身就超上限：只留该行尾部，仍是合法 UTF-8。
    #[test]
    fn push_tail_truncates_oversized_single_line() {
        let mut tail = String::new();
        push_tail(&mut tail, &"汉".repeat(STDERR_TAIL_LIMIT));
        assert!(tail.len() <= STDERR_TAIL_LIMIT);
        assert!(tail.trim_end_matches('\n').chars().all(|c| c == '汉'));
    }
}
