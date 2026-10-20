//! 跨进程存储锁。

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(super) const LOCK_DIR: &str = ".lock";
pub(super) const LOCK_OWNER_FILE: &str = "owner.json";
/// 超过该时长仍未释放的锁判为陈旧（持有进程崩溃/被 kill），可强行接管。
pub(super) const LOCK_STALE_MS: u128 = 30_000;
const LOCK_RETRY_DELAY: Duration = Duration::from_millis(25);
const LOCK_RETRY_LIMIT: u32 = 40;

pub(super) fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 会话存储的跨进程互斥锁。
///
/// 以「创建目录」作为原子的加锁动作（`create_dir` 在已存在时失败，POSIX 与 Windows
/// 皆然），目录内的 `owner.json` 只用于陈旧判定，不参与互斥本身 —— 因此不存在
/// 「先建目录再写 owner，中间被别人抢走」的窗口。RAII：Drop 即释放，panic 也能回收。
pub(super) struct StoreLock {
    dir: PathBuf,
}

impl StoreLock {
    pub(super) fn acquire(root: &Path) -> Result<Self, String> {
        let dir = root.join(LOCK_DIR);
        for _ in 0..LOCK_RETRY_LIMIT {
            match std::fs::create_dir(&dir) {
                Ok(()) => {
                    let owner =
                        serde_json::json!({ "pid": std::process::id(), "at": now_ms() as u64 });
                    // owner 写失败不致命（只影响陈旧判定精度），锁本身已经拿到
                    let _ = std::fs::write(dir.join(LOCK_OWNER_FILE), owner.to_string());
                    return Ok(Self { dir });
                }
                Err(err) if err.kind() == ErrorKind::AlreadyExists => {
                    if Self::is_stale(&dir) {
                        let _ = std::fs::remove_dir_all(&dir);
                        continue;
                    }
                    std::thread::sleep(LOCK_RETRY_DELAY);
                }
                Err(err) => return Err(format!("获取会话存储锁失败: {err}")),
            }
        }
        Err("会话存储锁被其它实例长期占用，本次同步放弃".into())
    }

    /// 锁是否陈旧：优先看 `owner.json` 的取锁时刻；文件尚未写出（持有者刚建目录）
    /// 或已损坏时退回目录 mtime，避免把刚拿到锁的对手误判为死锁。
    fn is_stale(dir: &Path) -> bool {
        if let Some(at) = std::fs::read_to_string(dir.join(LOCK_OWNER_FILE))
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|value| value.get("at").and_then(|at| at.as_u64()))
        {
            return now_ms().saturating_sub(u128::from(at)) > LOCK_STALE_MS;
        }
        std::fs::metadata(dir)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|at| at.elapsed().ok())
            .map(|age| age.as_millis() > LOCK_STALE_MS)
            .unwrap_or(false)
    }
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
