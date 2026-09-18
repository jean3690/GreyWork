//! 轻量结构化日志：文件 appender + 单文件轮转。
//!
//! 设计：
//! - 无第三方日志 crate——日志点低频（事件级），手写 append + 轮转 40 行自足。
//! - `init()` 在 setup 一次性指定目录（`app_data_dir/logs`）；未 init 时调用为
//!   no-op——library 单测与未接线的构建路径安全。
//! - 全局 `parking_lot::Mutex` 串行化 append（项目规则：无 std::sync 立即 unwrap）。
//! - 单文件超 1 MiB 轮转为 `<name>.1`（覆盖旧轮转文件）。
//! - 行格式：`ISO8601 UTC [LEVEL] (tag) message`；chrono 时钟沿用 db.rs 既有依赖。

use chrono::Utc;
use parking_lot::Mutex;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

/// 单文件大小上限：超限即轮转。
const MAX_LOG_BYTES: u64 = 1024 * 1024;

static LOG_FILE: OnceLock<Mutex<LogTarget>> = OnceLock::new();

struct LogTarget {
    dir: PathBuf,
    file_name: String,
}

/// 初始化日志目录（setup 调用一次；重复调用取首次设置，幂等）。
pub fn init(log_dir: PathBuf) {
    let _ = fs::create_dir_all(&log_dir);
    let _ = LOG_FILE.set(Mutex::new(LogTarget {
        dir: log_dir,
        file_name: "greywork.log".into(),
    }));
}

/// 日志目录（init 前为 None）——诊断面展示。
pub fn dir() -> Option<PathBuf> {
    LOG_FILE.get().map(|target| target.lock().dir.clone())
}

pub fn info(tag: &str, message: impl AsRef<str>) {
    write_line("INFO", tag, message);
}

pub fn error(tag: &str, message: impl AsRef<str>) {
    write_line("ERROR", tag, message);
}

pub fn warn(tag: &str, message: impl AsRef<str>) {
    write_line("WARN", tag, message);
}

fn write_line(level: &str, tag: &str, message: impl AsRef<str>) {
    let Some(target) = LOG_FILE.get() else {
        return; // 未 init：静默 no-op（测试/无宿主环境）
    };
    let line = format!(
        "{} [{level}] ({tag}) {}\n",
        Utc::now().to_rfc3339(),
        message.as_ref()
    );
    write(&target.lock(), &line);
}

/// 追加一行；超限先轮转（锁内执行，防并发交错写）。
fn write(target: &LogTarget, line: &str) {
    let path = target.dir.join(&target.file_name);
    if fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) > MAX_LOG_BYTES {
        let rotated = target.dir.join(format!("{}.1", target.file_name));
        let _ = fs::remove_file(&rotated);
        // 轮转失败必须留痕：Windows 上日志文件被别的进程/杀软占着时 rename 会一直失败，
        // 不记的话现象是「日志无限增长」而没人知道为什么。这里用 eprintln 而不是递归
        // 记日志 —— 本函数就是日志实现本身。
        if let Err(error) = fs::rename(&path, &rotated) {
            eprintln!("[greywork] 日志轮转失败（{}）: {error}", path.display());
        }
    }
    let Ok(mut file) = OpenOptions::new().append(true).create(true).open(&path) else {
        return;
    };
    let _ = file.write_all(line.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每测试独立子目录（cargo test 并行：共享目录会互删文件）。
    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("greywork-log-test-{}-{}", std::process::id(), name));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn lines_append_in_order() {
        let dir = temp_dir("lines_append_in_order");
        let path = dir.join("greywork.log");
        let _ = fs::remove_file(&path);
        let target = LogTarget {
            dir: dir.clone(),
            file_name: "greywork.log".into(),
        };
        write(&target, "INFO (scheduler) first\n");
        write(&target, "ERROR (llm) second\n");
        let content = fs::read_to_string(&path).expect("log exists");
        assert!(content.contains("first") && content.contains("second"));
        assert!(content.find("first").unwrap() < content.find("second").unwrap());
        // 清理
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn oversized_file_rotates_to_dot_one() {
        let dir = temp_dir("oversized_file_rotates_to_dot_one");
        let path = dir.join("greywork.log");
        let rotated = dir.join("greywork.log.1");
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(&rotated);
        let target = LogTarget {
            dir: dir.clone(),
            file_name: "greywork.log".into(),
        };
        // 写超一档（>1 MiB 触发轮转），再写一行新内容
        let filler = "x".repeat(MAX_LOG_BYTES as usize + 1);
        write(&target, &filler);
        write(&target, "INFO (scheduler) after-rotate\n");
        assert!(fs::metadata(&rotated).is_ok(), "rotated file exists");
        let content = fs::read_to_string(&path).expect("fresh log exists");
        assert_eq!(content, "INFO (scheduler) after-rotate\n", "主文件只剩新行");
        // 轮转文件保留旧内容
        let rotated_content = fs::read_to_string(&rotated).expect("rotated content");
        assert!(rotated_content.starts_with('x'));
        // 清理
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(&rotated);
    }

    #[test]
    fn uninitialized_log_is_noop() {
        // LOG_FILE 在其它测试可能已 set：本断言只看「调用不 panic」的语义；
        // 单独跑（cargo test log::）时 OnceLock 为空 → 必须安全返回。
        info("scheduler", "should-not-crash");
        error("llm", "should-not-crash");
    }

    #[test]
    fn init_then_info_lands_on_disk_with_timestamp() {
        let dir = temp_dir("init_then_info_lands_on_disk_with_timestamp");
        let path = dir.join("greywork.log");
        let _ = fs::remove_file(&path);
        init(dir.clone());
        info("scheduler", "hello-from-test");
        let content = fs::read_to_string(&path).expect("log written after init");
        assert!(content.contains("[INFO] (scheduler) hello-from-test"));
        assert!(content.starts_with("20"), "rfc3339 时间戳开头");
        let _ = fs::remove_file(&path);
    }
}
