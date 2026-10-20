//! 独立工作树执行外壳（runMode=worktree 的宿主侧）。
//!
//! 语义：`worktree_provision(source)` 把 ACP 工作区挪到一份**隔离快照**里——
//! - git 仓库 → 真实 `git worktree add -b greywork/<slug>-<hash>`（与新工作树共享对象库，
//!   不污染用户工作区）；在**命名分支**上检出，故 agent 的提交会落进源仓库共享的
//!   `refs/heads/*`、release 后仍可达（`--detach` 会随 worktree 一起丢掉提交）；
//! - 非 git 目录 → 演示兜底：整目录复制成独立副本（kind="copy"）；
//! - source 本身是应用数据根 `~/.greyWork` → 无需隔离（kind="direct"，原样返回）。
//!
//! 目标一律放在应用私有根 `~/.greyWork/worktrees/<slug>-<hash>` 下：
//! - `~/.greyWork` 是内置授权根，`acp_start` 的 `validate_existing` 天然放行、沙盒可直接绑定；
//! - 目录名对同一 source 是**确定性**的（净名 slug + 源路径短哈希），会话重连时
//!   `binding.cwd === workspace` 的比对不受影响。
//!
//! `worktree_release(root)` 负责回收：git 快照走 `git worktree remove`（标记文件里记录源，
//! 失败则退回整目录删除，worktree 本就是可丢弃快照），copy 直接删目录；只允许删
//! `worktrees` 基目录之下的条目，杜绝把用户目录或数据根当成快照删掉。
//!
//! `worktree_snapshot(root)` / `worktree_restore(root, ref)` 提供**回合级**的工作区快照与
//! 回退（会话+文件一起回退的宿主侧）：快照用临时索引写成 `refs/greywork/snap/<id>` 上的
//! 一个 commit（非破坏、不污染用户分支），回退把工作区硬还原到该快照。只对 `kind=git` 生效。
//!
//! # 子模块
//!
//! - [`dto`]：对外 DTO 与 provision 标记的读写；
//! - [`git`]：底层 git 执行、slug / 指纹 / 目标目录 / 分支命名；
//! - [`linked`]：`.agents/linked` 共享文件的符号链接；
//! - [`skills`]：`.agents/skills` 已安装技能带进快照 + run 级收敛；
//! - [`prepare`]：`.agents/prepare` 准备脚本；
//! - [`provision`]：生命周期 `provision` / `release` / `list`；
//! - [`snapshot`]：回合级快照与回退（`snapshot` / `restore`）；
//! - [`commands`]：命令实现入口与入参。

mod commands;
mod dto;
mod git;
mod linked;
mod prepare;
mod provision;
mod skills;
mod snapshot;

#[cfg(test)]
mod tests;

pub use commands::{
    worktree_list, worktree_provision, worktree_release, worktree_restore, worktree_snapshot,
    ProvisionArgs, ReleaseArgs, RestoreArgs, SnapshotArgs,
};
pub use dto::{WorktreeEntryDto, WorktreeProvisionDto};

use std::path::{Path, PathBuf};

/// 隔离快照的基目录名（`<应用数据>/worktrees`）。
const WORKTREES_SUB_DIR: &str = "worktrees";
/// 项目约定的 `.agents/` 目录（与 `.agents/skills/` 同源）。
const AGENTS_DIR: &str = ".agents";

/// 去掉 Windows `\\?\` 前缀，交出 git / 前端都能认的路径。
fn strip(raw: &Path) -> String {
    crate::path_safety::strip_verbatim_prefix(&raw.to_string_lossy())
}

/// 创建符号链接：Unix 一条路径；Windows 按源是目录还是文件分流。
///
/// `.agents/linked`（[`linked`]）与 `.agents/skills`（[`skills`]）共用同一条纪律：
/// 直接把链接指向**源**文件 / 目录，而不是复制。Windows 上创建符号链接需要开发者
/// 模式或管理员权限，失败时调用方只告警（功能降级，不是错误）。
pub(super) fn create_symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(src, dst)
    }
    #[cfg(windows)]
    {
        if src.is_dir() {
            std::os::windows::fs::symlink_dir(src, dst)
        } else {
            std::os::windows::fs::symlink_file(src, dst)
        }
    }
}

/// 把 `home` 折成 canonical 形态。
///
/// `resolve_existing`（源路径）与 `WorkspaceFsAccess::new`（授权根）都在 **canonical**
/// 形态上比对；worktree 层若拿**原始** `home` 去拼 `default_root` / `worktrees` 基目录，
/// 两边就会错位 —— macOS 的 `/var` → `/private/var`、Windows 的 `\\?\` 前缀或 8.3 短名，
/// 都会让同一个目录变成两个字符串。后果按严重度：
/// - 「源就是数据根」判定失效 → 把数据根复制进它自己的子目录 → `copy_dir` 无限递归爆栈；
/// - `release` 的 `starts_with` 守卫误拒合法快照（同一个目录被当成根外路径）。
///
/// `home` 一定存在（`home_dir()` / 测试临时目录），canonicalize 失败就原样返回，
/// 退化为旧行为而不是 panic。
fn canonical_home(home: &Path) -> PathBuf {
    std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf())
}
