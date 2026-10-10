//! 回合快照：会话 + 文件一起回退（A3a）。

use std::path::{Path, PathBuf};

use crate::core::ports::WorkspaceFs;
use crate::store_fs;

use super::dto::read_marker;
use super::git::{run_git, run_git_env};
use super::{canonical_home, strip, WORKTREES_SUB_DIR};

/// 回合快照的私有 ref 命名空间。刻意放在 `refs/greywork/` 而非 `refs/heads/`：既不进
/// `git branch`、不污染交回给用户的分支，又能随共享对象库留存（`git worktree remove`
/// 不会删 ref）。同名空间日后也可用于清理快照。
pub(super) const SNAPSHOT_REF_PREFIX: &str = "refs/greywork/snap";

/// 一次快照的唯一 id：纳秒时间戳 + pid + 进程内自增，做 ref 组件用。
/// 只需本机唯一（避免同一 worktree 重跑覆盖旧 ref），不需要跨机器。
fn snapshot_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{nanos:x}-{:x}-{seq:x}", std::process::id())
}

/// 校验入参是**我们自己的 git 隔离快照**，返回 canonical 后的根。
///
/// 与 `release` 同一条纪律：只允许 `~/.greyWork/worktrees` 之下的条目，且必须是
/// `kind=git`（copy/direct 没有可回退的版本历史）。
fn own_git_snapshot(
    access: &dyn WorkspaceFs,
    home: &Path,
    root_raw: &str,
) -> Result<PathBuf, String> {
    let root = access.resolve_existing(root_raw)?;
    let home = canonical_home(home);
    let worktrees_base = store_fs::default_root(&home)?.join(WORKTREES_SUB_DIR);
    if !root.starts_with(&worktrees_base) {
        return Err("只允许对 ~/.greyWork/worktrees 下的隔离快照做快照/回退".into());
    }
    let kind = read_marker(&root)
        .map(|marker| marker.kind)
        .unwrap_or_default();
    if kind != "git" {
        return Err("只有 git 隔离快照支持快照与回退".into());
    }
    Ok(root)
}

/// 记一次工作区快照，返回其 ref 名（交回渲染层挂到消息上）。
///
/// 用**临时索引**（`GIT_INDEX_FILE`）构建整棵工作树的 tree，再写成 `refs/greywork/snap/<id>`
/// 上的一个 commit：真实的 index 与分支 tip 都**不动**，agent 无感；`.gitignore` 忽略的文件
/// 不进快照。每个快照是一棵**完整树**（非增量），`git diff HEAD <ref>` 即「到此为止的全部改动」。
pub(super) fn snapshot(
    access: &dyn WorkspaceFs,
    home: &Path,
    root_raw: &str,
) -> Result<String, String> {
    let root = own_git_snapshot(access, home, root_raw)?;
    let root_plain = strip(&root);
    let workdir = Path::new(&root_plain);

    // 临时索引放系统临时目录，用完即删；不与真实 .git/index 争用。
    let index_path = std::env::temp_dir().join(format!("greywork-idx-{}", snapshot_id()));
    let _ = std::fs::remove_file(&index_path);
    let index = index_path.to_string_lossy().into_owned();
    let envs = [("GIT_INDEX_FILE", index.as_str())];

    let build = (|| -> Result<String, String> {
        run_git_env(workdir, &["read-tree", "HEAD"], &envs)?;
        run_git_env(workdir, &["add", "-A"], &envs)?;
        let tree = run_git_env(workdir, &["write-tree"], &envs)?;
        let tree = tree.trim().to_string();
        let parent = run_git_env(workdir, &["rev-parse", "HEAD"], &[])?;
        let parent = parent.trim().to_string();
        // 内部快照提交用固定身份，免得用户仓库没配 user.name/email 时 commit-tree 直接失败。
        let commit = run_git_env(
            workdir,
            &[
                "-c",
                "user.name=greywork",
                "-c",
                "user.email=greywork@localhost",
                "commit-tree",
                tree.as_str(),
                "-p",
                parent.as_str(),
                "-m",
                "greywork snapshot",
            ],
            &[],
        )?;
        Ok(commit.trim().to_string())
    })();
    let _ = std::fs::remove_file(&index_path);
    let commit = build?;

    let reference = format!("{SNAPSHOT_REF_PREFIX}/{}", snapshot_id());
    run_git(
        workdir,
        &["update-ref", reference.as_str(), commit.as_str()],
    )?;
    Ok(reference)
}

/// 把工作区硬回退到某个快照 ref（**严格等于快照**：快照之后新建的文件会被删掉）。
///
/// 步骤：`read-tree --reset -u`（工作区+索引 := 快照）→ `clean -fd`（删掉快照之后新建的
/// 文件；不带 `-x`，故 `.gitignore` 忽略的构建产物保留）→ `reset`（索引 := 分支 HEAD，工作区
/// 不变，于是回退后的差异表现为普通的未暂存改动）。
pub(super) fn restore(
    access: &dyn WorkspaceFs,
    home: &Path,
    root_raw: &str,
    reference: &str,
) -> Result<(), String> {
    let root = own_git_snapshot(access, home, root_raw)?;
    if !reference.starts_with(&format!("{SNAPSHOT_REF_PREFIX}/")) {
        return Err(format!("只允许回退到 {SNAPSHOT_REF_PREFIX}/* 下的快照"));
    }
    let root_plain = strip(&root);
    let workdir = Path::new(&root_plain);
    // 先确认 ref 存在且指向 commit，免得 read-tree 抛出难懂的错。
    run_git(
        workdir,
        &["rev-parse", "--verify", &format!("{reference}^{{commit}}")],
    )?;
    run_git(workdir, &["read-tree", "--reset", "-u", reference])?;
    run_git(workdir, &["clean", "-fdq"])?;
    run_git(workdir, &["reset", "-q"])?;
    Ok(())
}
