//! 交互式终端（真 PTY）：多会话、流式 IO，体验对标「电脑上的终端」。
//!
//! 与同层的 [`super::shell`]（一次性命令运行器）并列：那条路无 PTY，`vim`/`top` 这类
//! 全屏 TUI 跑不起来；这里是真终端 —— 每开一个标签页就是一个 PTY 子进程，支持交互输入、
//! 密码、彩色提示符、进度条、窗口尺寸（SIGWINCH）。
//!
//! 安全边界与 `shell` 一样，**不在本模块**，而在「谁能调用」：`terminal_*` 全属
//! `TRUSTED_HOST_ONLY`（见 `apps/server/src/policy.rs`）—— 可信本机宿主（Electron 壳 /
//! 本地宿主）才放行，网络暴露的部署一律 403。PTY 比 `shell_run` 更宽（可持续交互、能跑
//! 任意程序），所以这条边界尤其不能省。
//!
//! # IO 模型
//!
//! - **输出**：每个会话一个 std 读线程，把 PTY 字节 base64 后经 `terminal://data` 事件
//!   推给前端（走 [`HostContext::emit`]；服务端即 WS 广播通道）。base64 而非 UTF-8 字符串：
//!   分块读取可能把一个多字节字符切成两半，前端拿到 `Uint8Array` 交给 xterm 才能正确续接。
//! - **输入 / 改尺寸 / 关闭**：同步命令，拿会话写端写字节 / `resize` / 杀进程。
//! - **退出**：读线程见 EOF 后发 `terminal://exit`。
//!
//! 会话不因前端断连而回收（多标签、面板开合都要保活）；标签页关闭时显式 `close`，
//! 进程退出时 [`Drop`] 兜底杀干净。

mod shells;
#[cfg(test)]
mod tests;

pub use shells::{ShellCatalog, ShellOption};

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use base64::Engine;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtyPair, PtySize};
use serde::{Deserialize, Serialize};

use crate::core::host::{emit_json, HostContext};
use crate::infra::process_guard;
use crate::infra::workspace_fs::WorkspaceFsAccess;

/// 缺省窗口大小（80×24），与真终端一致；前端挂载 xterm 后会立刻按实际尺寸 `resize`。
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;
/// 尺寸夹紧：防前端传 0 / 极大值把 PTY 搞坏。
const MIN_DIM: u16 = 2;
const MAX_DIM: u16 = 1000;
/// 单次读取块大小（8 KiB）。
const READ_CHUNK: usize = 8192;
/// 输出事件名（前端 `listen` 同名）。
pub const DATA_EVENT: &str = "terminal://data";
/// 会话退出事件名。
pub const EXIT_EVENT: &str = "terminal://exit";

/// `terminal_open` 入参（与前端扁平 camelCase 对齐）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenArgs {
    /// 会话 id：前端建标签时先生成、**先订阅事件、再带着它来开** —— 否则 shell 已回显的
    /// 首屏提示符可能在订阅生效前发出而丢掉。缺省由后端生成（脚本 / 旧调用方）。
    #[serde(default)]
    pub session_id: Option<String>,
    /// 工作目录：显式给出时必须是**已授权**的既有路径；缺省用宿主默认根。
    #[serde(default)]
    pub cwd: Option<String>,
    /// shell id（取自 `terminal_shells`）；缺省 / 未知用默认 shell。
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
}

/// `terminal_open` 结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub session_id: String,
    /// 实际落点的工作目录（前端标题条显示）。
    pub cwd: String,
    pub shell_id: String,
    pub shell_label: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteArgs {
    pub session_id: String,
    /// 键盘输入（UTF-8 文本，含转义序列）。
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeArgs {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseArgs {
    pub session_id: String,
}

/// 一条活动会话：主端（改尺寸 / 写）、子进程（杀）、退出标记。
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// 读线程在 EOF 时置真；写 / 改尺寸据此短路（进程没了，再写只会报错）。
    exited: Arc<AtomicBool>,
}

/// 交互式终端宿主：会话表 + 事件出口。建一次，跨请求复用（见 `Services`）。
pub struct TerminalHost {
    host: Arc<dyn HostContext>,
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
    seq: AtomicU64,
}

impl TerminalHost {
    pub fn new(host: Arc<dyn HostContext>) -> Self {
        Self {
            host,
            sessions: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
        }
    }

    /// 本机可用的终端环境（`terminal_shells`）。
    pub fn catalog(&self) -> ShellCatalog {
        shells::catalog()
    }

    /// 开一个新会话：起 PTY + shell 子进程，挂上读线程推 `terminal://data`。
    pub fn open(&self, access: &WorkspaceFsAccess, args: OpenArgs) -> Result<OpenResult, String> {
        let cwd = match args
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|raw| !raw.is_empty())
        {
            Some(raw) => access.resolve_existing(raw)?,
            None => access.default_root().to_path_buf(),
        };
        let shell = shells::resolve(args.shell.as_deref())
            .ok_or_else(|| "本机没有可用的 shell".to_string())?;
        let cols = args.cols.unwrap_or(DEFAULT_COLS).clamp(MIN_DIM, MAX_DIM);
        let rows = args.rows.unwrap_or(DEFAULT_ROWS).clamp(MIN_DIM, MAX_DIM);

        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("打开 PTY 失败: {error}"))?;
        let PtyPair { slave, master } = pair;

        let mut command = CommandBuilder::new(shell.program.as_os_str());
        for arg in &shell.args {
            command.arg(arg);
        }
        command.cwd(&cwd);
        // 让依赖 `$TERM` 的程序（ls --color / vim / tmux）拿到彩色与能力集。
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        // GUI / 服务启动时继承的 PATH 可能残缺，注入登录 shell 解析出的 PATH（同 shell.rs）。
        if let Some((key, value)) = process_guard::path_env() {
            command.env(key, value);
        }

        let child = slave
            .spawn_command(command)
            .map_err(|error| format!("启动 shell 失败: {error}"))?;
        // 关键：放下 slave 端，否则子进程退出后主端读线程看不到 EOF。
        drop(slave);

        let reader = master
            .try_clone_reader()
            .map_err(|error| format!("获取终端读端失败: {error}"))?;
        let writer = master
            .take_writer()
            .map_err(|error| format!("获取终端写端失败: {error}"))?;

        let session_id = match args
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|raw| !raw.is_empty())
        {
            Some(raw) if self.sessions.lock().contains_key(raw) => {
                return Err(format!("会话 id 已存在: {raw}"));
            }
            Some(raw) => raw.to_string(),
            None => self.next_id(),
        };
        let exited = Arc::new(AtomicBool::new(false));
        spawn_reader(
            reader,
            Arc::clone(&self.host),
            session_id.clone(),
            Arc::clone(&exited),
        );

        self.sessions.lock().insert(
            session_id.clone(),
            Arc::new(Mutex::new(Session {
                master,
                writer,
                child,
                exited,
            })),
        );

        Ok(OpenResult {
            session_id,
            cwd: cwd.display().to_string(),
            shell_id: shell.id,
            shell_label: shell.label,
        })
    }

    /// 把键盘输入写进会话。
    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let session = self.session(session_id)?;
        let mut guard = session.lock();
        if guard.exited.load(Ordering::Relaxed) {
            return Ok(());
        }
        guard
            .writer
            .write_all(data.as_bytes())
            .and_then(|()| guard.writer.flush())
            .map_err(|error| format!("写入终端失败: {error}"))
    }

    /// 通知内核新窗口尺寸（子进程收到 SIGWINCH）。
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.session(session_id)?;
        let guard = session.lock();
        if guard.exited.load(Ordering::Relaxed) {
            return Ok(());
        }
        guard
            .master
            .resize(PtySize {
                rows: rows.clamp(MIN_DIM, MAX_DIM),
                cols: cols.clamp(MIN_DIM, MAX_DIM),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("调整终端尺寸失败: {error}"))
    }

    /// 关掉会话：杀子进程；读线程会在 EOF 后自行退出并发 `terminal://exit`。
    pub fn close(&self, session_id: &str) {
        let removed = self.sessions.lock().remove(session_id);
        if let Some(session) = removed {
            kill_session(&session);
        }
    }

    fn session(&self, session_id: &str) -> Result<Arc<Mutex<Session>>, String> {
        self.sessions
            .lock()
            .get(session_id)
            .cloned()
            .ok_or_else(|| "终端会话不存在".to_string())
    }

    fn next_id(&self) -> String {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        format!("term-{}-{seq}", std::process::id())
    }
}

impl Drop for TerminalHost {
    fn drop(&mut self) {
        for (_, session) in self.sessions.lock().drain() {
            kill_session(&session);
        }
    }
}

fn kill_session(session: &Arc<Mutex<Session>>) {
    let mut guard = session.lock();
    guard.exited.store(true, Ordering::Relaxed);
    let _ = guard.child.kill();
}

/// 读线程：把 PTY 输出 base64 后推事件，EOF 时推退出事件。
fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    host: Arc<dyn HostContext>,
    session_id: String,
    exited: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let mut chunk = [0u8; READ_CHUNK];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&chunk[..read]);
                    emit_json(
                        host.as_ref(),
                        DATA_EVENT,
                        DataEvent {
                            session_id: session_id.as_str(),
                            data: data.as_str(),
                        },
                    );
                }
                Err(_) => break,
            }
        }
        exited.store(true, Ordering::Relaxed);
        emit_json(
            host.as_ref(),
            EXIT_EVENT,
            ExitEvent {
                session_id: session_id.as_str(),
            },
        );
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DataEvent<'a> {
    session_id: &'a str,
    /// base64 编码的原始字节（xterm 收 `Uint8Array`）。
    data: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitEvent<'a> {
    session_id: &'a str,
}
