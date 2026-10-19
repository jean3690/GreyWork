//! `terminal` 模块单测：真起 PTY 子进程，验会话生命周期与事件流。
//!
//! 只在 Unix 上跑「起 shell」的用例（CI 的 Linux job 有 `/bin/sh`）；探测表用例跨平台。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::core::host::HostPaths;

use super::*;

/// 捕获到的事件序列：`(事件名, 载荷)`。
type Events = Arc<Mutex<Vec<(String, Value)>>>;

/// 记录事件的桩宿主。
struct RecordingHost {
    paths: HostPaths,
    events: Events,
}

impl HostContext for RecordingHost {
    fn paths(&self) -> &HostPaths {
        &self.paths
    }
    fn emit(&self, event: &str, payload: Value) {
        self.events.lock().push((event.to_string(), payload));
    }
    fn notify(&self, _title: &str, _body: &str) {}
}

fn recording() -> (Arc<dyn HostContext>, Events) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let host: Arc<dyn HostContext> = Arc::new(RecordingHost {
        paths: HostPaths::new(
            std::env::temp_dir().join("greywork-terminal-home"),
            std::env::temp_dir().join("greywork-terminal-data"),
        ),
        events: Arc::clone(&events),
    });
    (host, events)
}

fn temp_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("系统时间早于 UNIX 纪元")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("greywork-terminal-{tag}-{nanos}"));
    std::fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

fn access(tag: &str) -> (WorkspaceFsAccess, PathBuf) {
    let root = temp_dir(tag);
    let project = root.join("proj");
    std::fs::create_dir_all(&project).expect("创建项目目录");
    let access = WorkspaceFsAccess::new(&root, root.join("access.json")).expect("构造授权面");
    (access, project)
}

fn open_args(cwd: Option<&Path>) -> OpenArgs {
    OpenArgs {
        session_id: None,
        cwd: cwd.map(|path| path.display().to_string()),
        shell: None,
        cols: Some(80),
        rows: Some(24),
    }
}

/// 把某会话收到的 `terminal://data` base64 解出来拼成文本。
fn collected(events: &Events, session_id: &str) -> String {
    let mut text = String::new();
    for (event, payload) in events.lock().iter() {
        if event != DATA_EVENT || payload["sessionId"].as_str() != Some(session_id) {
            continue;
        }
        let Some(encoded) = payload["data"].as_str() else {
            continue;
        };
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) {
            text.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    text
}

fn wait_for<F: Fn() -> bool>(predicate: F) -> bool {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if predicate() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

#[test]
fn catalog_is_non_empty_on_unix() {
    if !cfg!(unix) {
        return;
    }
    let catalog = shells::catalog();
    assert!(!catalog.shells.is_empty(), "Unix 上至少应探测到一个 shell");
    assert!(catalog.default_id.is_some(), "应有默认 shell");
    // id 唯一：前端按 id 选中，重复会让选择器指向不确定的那一个。
    let mut ids: Vec<&str> = catalog
        .shells
        .iter()
        .map(|shell| shell.id.as_str())
        .collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), catalog.shells.len(), "shell id 应唯一");
}

#[cfg(unix)]
#[test]
fn open_streams_output_and_close_removes_session() {
    let (host, events) = recording();
    let (access, project) = access("stream");
    let terminal = TerminalHost::new(host);

    let opened = terminal
        .open(&access, open_args(Some(&project)))
        .expect("开终端");
    assert!(
        opened.cwd.ends_with("proj"),
        "cwd 应是项目目录: {}",
        opened.cwd
    );
    assert!(!opened.shell_id.is_empty());

    terminal
        .write(&opened.session_id, "echo GREYWORK_TERM_OK\n")
        .expect("写入命令");
    let session = opened.session_id.clone();
    assert!(
        wait_for(|| collected(&events, &session).contains("GREYWORK_TERM_OK")),
        "应看到命令输出: {:?}",
        collected(&events, &session)
    );

    terminal.write(&opened.session_id, "exit\n").expect("退出");
    let session = opened.session_id.clone();
    assert!(
        wait_for(|| events
            .lock()
            .iter()
            .any(|(event, payload)| event == EXIT_EVENT
                && payload["sessionId"].as_str() == Some(session.as_str()))),
        "应收到退出事件"
    );

    terminal.close(&opened.session_id);
    assert!(
        terminal.write(&opened.session_id, "x").is_err(),
        "关闭后会话应不存在"
    );
}

#[cfg(unix)]
#[test]
fn resize_is_accepted_while_alive() {
    let (host, _events) = recording();
    let (access, project) = access("resize");
    let terminal = TerminalHost::new(host);
    let opened = terminal
        .open(&access, open_args(Some(&project)))
        .expect("开终端");

    assert!(
        terminal.resize(&opened.session_id, 120, 40).is_ok(),
        "活动会话应能改尺寸"
    );
    terminal.close(&opened.session_id);
}

#[cfg(unix)]
#[test]
fn unknown_shell_falls_back_to_default() {
    let (host, _events) = recording();
    let (access, project) = access("fallback");
    let terminal = TerminalHost::new(host);
    let mut args = open_args(Some(&project));
    args.shell = Some("definitely-not-a-real-shell".to_string());

    let opened = terminal
        .open(&access, args)
        .expect("未知 id 应回落默认 shell");
    assert!(!opened.shell_id.is_empty());
    terminal.close(&opened.session_id);
}

#[cfg(unix)]
#[test]
fn uses_provided_session_id_and_rejects_duplicates() {
    let (host, _events) = recording();
    let (access, project) = access("session-id");
    let terminal = TerminalHost::new(host);

    let mut args = open_args(Some(&project));
    args.session_id = Some("fixed-id".to_string());
    let opened = terminal.open(&access, args).expect("开终端");
    assert_eq!(opened.session_id, "fixed-id");

    // 同一 id 再开应被拒：否则会把正在用的会话从表里挤掉。
    let mut again = open_args(Some(&project));
    again.session_id = Some("fixed-id".to_string());
    assert!(terminal.open(&access, again).is_err(), "重复 id 应被拒");

    terminal.close("fixed-id");
}

#[test]
fn rejects_unauthorized_cwd() {
    let (host, _events) = recording();
    let (access, _project) = access("unauthorized");
    let terminal = TerminalHost::new(host);

    let error = terminal
        .open(&access, open_args(Some(Path::new("/"))))
        .expect_err("根目录不在授权面内");
    assert!(error.contains("授权"), "实际: {error}");
}
