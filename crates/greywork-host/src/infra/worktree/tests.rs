use std::path::{Path, PathBuf};
use std::process::Command;

use crate::store_fs;
use crate::workspace_fs::WorkspaceFsAccess;

use super::dto::WorktreeProvisionDto;
use super::git::{deterministic_target, run_git, worktree_branch};
use super::linked::is_safe_relative;
use super::provision::{list, provision, release};
use super::snapshot::{restore, snapshot, SNAPSHOT_REF_PREFIX};
use super::{canonical_home, strip, WORKTREES_SUB_DIR};

fn temp_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("系统时间早于 UNIX 纪元")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("greywork-worktree-{tag}-{nanos}"));
    std::fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

/// 授权根是 home：源项目放 home 下，worktree 目标在 home/.greyWork 下，都覆盖在根内。
fn home_fixture(tag: &str) -> (PathBuf, WorkspaceFsAccess) {
    // 与宿主同形：授权根与 worktree 层都在 canonical 形态上比对（macOS 的 `/var` 是
    // 符号链接、Windows `canonicalize` 会加 `\\?\`），测试也用 canonical 的 home 才一致。
    let home = canonical_home(&temp_dir(tag));
    let access = WorkspaceFsAccess::new(&home, home.join("gw-worktree-access-test.json"))
        .expect("创建授权状态");
    (home, access)
}

fn git_available() {
    let output = Command::new("git")
        .arg("--version")
        .output()
        .expect("启动 git 探测");
    assert!(
        output.status.success(),
        "Rust 单测需要系统 git 可用：\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn init_repo(root: &Path) {
    git_available();
    Command::new("git")
        .current_dir(root)
        .args(["init", "-q", "-b", "main"])
        .status()
        .expect("git init");
    for (key, value) in [
        ("user.name", "GreyWork Test"),
        ("user.email", "test@greywork.local"),
    ] {
        Command::new("git")
            .current_dir(root)
            .args(["config", key, value])
            .status()
            .expect("git config");
    }
    std::fs::write(root.join("a.txt"), "one\n").expect("写 a");
    Command::new("git")
        .current_dir(root)
        .args(["add", "-A"])
        .status()
        .expect("git add");
    Command::new("git")
        .current_dir(root)
        .args(["commit", "-m", "init"])
        .status()
        .expect("git commit");
}

/// 普通目录快照：复制兜底。
#[test]
fn plain_dir_uses_copy_fallback() {
    let (home, access) = home_fixture("copy-src");
    let root = home.join("project");
    std::fs::create_dir_all(&root).expect("建源目录");
    std::fs::write(root.join("x.txt"), "x\n").expect("写文件");
    std::fs::create_dir(root.join("sub")).expect("建子目录");
    std::fs::write(root.join("sub/y.txt"), "y\n").expect("写子文件");
    let dto = provision(&access, &home, &root.to_string_lossy(), false).expect("provision");
    assert_eq!(dto.kind, "copy");
    let target = PathBuf::from(&dto.root);
    assert!(target.join("x.txt").is_file());
    assert!(target.join("sub/y.txt").is_file());
    assert_eq!(
        target,
        PathBuf::from(strip(
            &home
                .join(".greyWork/worktrees")
                .join(deterministic_target_name(&root).unwrap())
        ))
    );
    // 幂等：同一 source 返回同一目录
    let again = provision(&access, &home, &root.to_string_lossy(), false).expect("再次 provision");
    assert_eq!(again.root, dto.root);
    release(&access, &home, &dto.root).expect("release");
    assert!(!target.exists());
    let _ = std::fs::remove_dir_all(home);
}

/// 复制快照不带走 .git / .greyWork（应用私有数据与 git 元数据都不该进快照）。
#[test]
fn copy_skips_git_and_app_data() {
    let (home, access) = home_fixture("copy-skip");
    let root = home.join("project");
    std::fs::create_dir_all(&root).expect("建源目录");
    std::fs::write(root.join(".git"), "# 假 gitdir").expect("写 .git");
    std::fs::write(root.join(".greyWork"), "app data").expect("写 .greyWork");
    std::fs::write(root.join("keep.txt"), "k\n").expect("写保留文件");
    let dto = provision(&access, &home, &root.to_string_lossy(), false).expect("provision");
    let target = PathBuf::from(&dto.root);
    assert!(target.join("keep.txt").is_file());
    assert!(!target.join(".git").exists());
    assert!(!target.join(".greyWork").exists());
    let _ = std::fs::remove_dir_all(home);
}

/// git 仓库：真实 worktree。
#[test]
fn git_repo_creates_real_worktree() {
    let (home, access) = home_fixture("git-repo");
    let repo = home.join("repo");
    std::fs::create_dir_all(&repo).expect("建仓库目录");
    init_repo(&repo);
    std::fs::write(repo.join("new.txt"), "n\n").expect("写未提交文件");
    let dto = provision(&access, &home, &repo.to_string_lossy(), false).expect("provision");
    assert_eq!(dto.kind, "git");
    let target = PathBuf::from(&dto.root);
    assert!(target.is_dir());
    // 真实 worktree 的特征：目录里有 .git 文件（指向共享对象库）
    assert!(target.join(".git").is_file());
    // 源仓库的未提交文件不会出现在新 worktree 里（独立 checkout）
    assert!(!target.join("new.txt").exists());
    // 幂等
    let again = provision(&access, &home, &repo.to_string_lossy(), false).expect("再次 provision");
    assert_eq!(again.root, dto.root);
    // release 后 git 不再认识这个 worktree
    release(&access, &home, &dto.root).expect("release");
    assert!(!target.exists());
    let list = Command::new("git")
        .current_dir(&repo)
        .args(["worktree", "list"])
        .output()
        .expect("worktree list");
    assert!(!String::from_utf8_lossy(&list.stdout).contains(target.to_str().unwrap()));
    let _ = std::fs::remove_dir_all(home);
}

/// A2：git 快照在**命名分支**上检出（而非 `--detach`），分支落进源仓库共享 refs。
#[test]
fn git_repo_worktree_uses_named_branch() {
    let (home, access) = home_fixture("branch-name");
    let repo = home.join("repo");
    std::fs::create_dir_all(&repo).expect("建仓库目录");
    init_repo(&repo);
    let dto = provision(&access, &home, &repo.to_string_lossy(), false).expect("provision");
    assert_eq!(dto.kind, "git");
    let target = PathBuf::from(&dto.root);

    let expected = worktree_branch(&repo);
    assert!(
        expected.starts_with("greywork/"),
        "分支应带 greywork/ 前缀: {expected}"
    );
    // 分支名 = `greywork/` + 快照目录名（同一份 slug+指纹）
    assert_eq!(
        expected,
        format!("greywork/{}", target.file_name().unwrap().to_string_lossy())
    );
    // 工作树 HEAD 在该分支上，且不是 detached
    let head = run_git(&target, &["branch", "--show-current"]).expect("取当前分支");
    assert_eq!(head.trim(), expected);
    // 源仓库能看到这个分支（共享 refs —— 无需 remote 即完成交回）
    let branches = run_git(&repo, &["branch", "--list", expected.as_str()]).expect("列分支");
    assert!(branches.contains(&expected), "源仓库应能看到快照分支");
    let _ = std::fs::remove_dir_all(home);
}

/// A2：release 之后分支与提交仍在源仓库里（`--detach` 会随 worktree 一起丢，命名分支不会）。
#[test]
fn release_keeps_branch_and_commits() {
    let (home, access) = home_fixture("branch-keep");
    let repo = home.join("repo");
    std::fs::create_dir_all(&repo).expect("建仓库目录");
    init_repo(&repo);
    let dto = provision(&access, &home, &repo.to_string_lossy(), false).expect("provision");
    let target = PathBuf::from(&dto.root);
    // 在快照里造一个提交（模拟 agent 的产出）
    std::fs::write(target.join("agent.txt"), "work\n").expect("写 agent 产物");
    git_in(&target, &["add", "-A"]);
    git_in(&target, &["commit", "-m", "agent work"]);

    release(&access, &home, &dto.root).expect("release");
    assert!(!target.exists());

    // 分支仍在，且提交可达 —— 这就是「交回用户」的意义
    let branch = worktree_branch(&repo);
    let log = run_git(&repo, &["log", "--oneline", branch.as_str()]).expect("分支日志");
    assert!(log.contains("agent work"), "release 后提交应仍可达: {log}");
    let _ = std::fs::remove_dir_all(home);
}

/// A2：release 后再 provision 复用同一分支、保留旧提交（绝不 `-B` 重置）。
#[test]
fn reprovision_reuses_existing_branch() {
    let (home, access) = home_fixture("branch-reuse");
    let repo = home.join("repo");
    std::fs::create_dir_all(&repo).expect("建仓库目录");
    init_repo(&repo);
    let dto = provision(&access, &home, &repo.to_string_lossy(), false).expect("provision");
    let target = PathBuf::from(&dto.root);
    std::fs::write(target.join("agent.txt"), "work\n").expect("写 agent 产物");
    git_in(&target, &["add", "-A"]);
    git_in(&target, &["commit", "-m", "agent work"]);
    release(&access, &home, &dto.root).expect("release");

    // 再派一次：目录名确定、分支已存在 → 应复用（挂到旧分支）而非重置或回落复制
    let again = provision(&access, &home, &repo.to_string_lossy(), false).expect("再 provision");
    assert_eq!(again.kind, "git", "应复用命名分支而不是回落复制");
    assert_eq!(again.root, dto.root);
    let target2 = PathBuf::from(&again.root);
    let head = run_git(&target2, &["branch", "--show-current"]).expect("取当前分支");
    assert_eq!(head.trim(), worktree_branch(&repo));
    // 旧提交还在（-B 重置会丢掉它）
    assert!(
        target2.join("agent.txt").is_file(),
        "复用分支应保留旧提交的文件"
    );
    let _ = std::fs::remove_dir_all(home);
}

/// 建一个 git 仓库并 provision 成隔离快照，返回 (home, access, dto)。
fn git_snapshot_fixture(tag: &str) -> (PathBuf, WorkspaceFsAccess, WorktreeProvisionDto) {
    let (home, access) = home_fixture(tag);
    let repo = home.join("repo");
    std::fs::create_dir_all(&repo).expect("建仓库目录");
    init_repo(&repo);
    let dto = provision(&access, &home, &repo.to_string_lossy(), false).expect("provision");
    assert_eq!(dto.kind, "git");
    (home, access, dto)
}

/// A3a：快照用临时索引，不改变工作区/索引状态（agent 无感），且不落在 refs/heads。
#[test]
fn snapshot_leaves_worktree_state_intact() {
    let (home, access, dto) = git_snapshot_fixture("snap-intact");
    let wt = PathBuf::from(&dto.root);
    std::fs::write(wt.join("a.txt"), "two\n").expect("改 a");
    std::fs::write(wt.join("new.txt"), "n\n").expect("加 new");

    let before = run_git(&wt, &["status", "--porcelain"]).expect("status");
    let reference = snapshot(&access, &home, &dto.root).expect("snapshot");
    let after = run_git(&wt, &["status", "--porcelain"]).expect("status");

    assert_eq!(before, after, "快照不应改变工作区/索引状态");
    assert!(reference.starts_with(SNAPSHOT_REF_PREFIX));
    // 私有 ref 不进 git branch（refs/heads 之外）
    let branches = run_git(&wt, &["branch", "--list", "greywork/*"]).expect("列分支");
    assert!(
        !branches.contains("snap"),
        "快照 ref 不应出现在分支列表: {branches}"
    );
    let _ = std::fs::remove_dir_all(home);
}

/// A3a：快照 + 硬回退往返 —— 改动回到快照点，快照之后新建的文件被删除。
#[test]
fn snapshot_then_restore_roundtrips() {
    let (home, access, dto) = git_snapshot_fixture("snap-roundtrip");
    let wt = PathBuf::from(&dto.root);
    // 快照点：改 tracked、加 untracked、加嵌套
    std::fs::write(wt.join("a.txt"), "two\n").expect("改 a");
    std::fs::write(wt.join("new.txt"), "n\n").expect("加 new");
    std::fs::create_dir_all(wt.join("sub")).expect("建 sub");
    std::fs::write(wt.join("sub/deep.txt"), "d\n").expect("写 deep");
    let reference = snapshot(&access, &home, &dto.root).expect("snapshot");

    // 快照之后继续改
    std::fs::write(wt.join("a.txt"), "three\n").expect("再改 a");
    std::fs::write(wt.join("later.txt"), "l\n").expect("加 later");

    restore(&access, &home, &dto.root, &reference).expect("restore");

    assert_eq!(std::fs::read_to_string(wt.join("a.txt")).unwrap(), "two\n");
    assert!(wt.join("new.txt").is_file(), "快照里的 untracked 应还原");
    assert!(wt.join("sub/deep.txt").is_file(), "嵌套文件应还原");
    assert!(
        !wt.join("later.txt").exists(),
        "快照之后新建的文件应被删除（硬恢复）"
    );
    // 分支 tip 未动（仍停在 init）——快照/回退都不移动交回给用户的分支
    let head = run_git(&wt, &["log", "--oneline", "-1"]).expect("log");
    assert!(head.contains("init"), "分支 tip 不应被移动: {head}");
    let _ = std::fs::remove_dir_all(home);
}

/// A3a：copy 快照没有版本历史，快照命令应拒绝。
#[test]
fn snapshot_rejects_non_git_snapshot() {
    let (home, access) = home_fixture("snap-nongit");
    let plain = home.join("project");
    std::fs::create_dir_all(&plain).expect("建源目录");
    std::fs::write(plain.join("x.txt"), "x\n").expect("写文件");
    let dto = provision(&access, &home, &plain.to_string_lossy(), false).expect("provision");
    assert_eq!(dto.kind, "copy");
    assert!(snapshot(&access, &home, &dto.root).is_err());
    let _ = std::fs::remove_dir_all(home);
}

/// A3a：回退只接受私有命名空间下的 ref，拒绝任意 ref（如用户分支）。
#[test]
fn restore_rejects_foreign_reference() {
    let (home, access, dto) = git_snapshot_fixture("snap-foreign");
    let error = restore(&access, &home, &dto.root, "refs/heads/main").expect_err("应拒绝");
    assert!(
        error.contains(SNAPSHOT_REF_PREFIX),
        "错误应指明命名空间: {error}"
    );
    let _ = std::fs::remove_dir_all(home);
}

/// A3a：快照 ref 落在私有命名空间，release（删 worktree）后仍在共享对象库里。
#[test]
fn snapshot_ref_survives_release() {
    let (home, access, dto) = git_snapshot_fixture("snap-survive");
    let wt = PathBuf::from(&dto.root);
    std::fs::write(wt.join("a.txt"), "two\n").expect("改 a");
    let reference = snapshot(&access, &home, &dto.root).expect("snapshot");

    let repo = home.join("repo");
    release(&access, &home, &dto.root).expect("release");
    assert!(!wt.exists());

    let listed = run_git(
        &repo,
        &["for-each-ref", "--format=%(refname)", "refs/greywork"],
    )
    .expect("列 ref");
    assert!(
        listed.contains(&reference),
        "release 后快照 ref 应仍在: {listed}"
    );
    let kind = run_git(&repo, &["cat-file", "-t", reference.as_str()]).expect("cat-file");
    assert_eq!(kind.trim(), "commit");
    let _ = std::fs::remove_dir_all(home);
}

/// 数据根直通：不给 ~/.greyWork 造分身，且不可被 release 删除。
#[test]
fn default_root_passes_through() {
    let home = canonical_home(&temp_dir("direct-home"));
    let base = store_fs::default_root(&home).expect("default root");
    let access = WorkspaceFsAccess::new(&base, base.join("gw-access.json")).expect("授权");
    let dto = provision(&access, &home, &base.to_string_lossy(), false).expect("provision");
    assert_eq!(dto.kind, "direct");
    // 直通返回源的 strip 形态，与 provision 其余分支的返回值同形。
    assert_eq!(dto.root, strip(&base));
    // 直通不落快照，故不出现在列表里（WorktreeEntryDto 文档承诺的不变量）。
    assert!(list(&home).expect("list").is_empty());
    assert!(release(&access, &home, &base.to_string_lossy()).is_err());
    let _ = std::fs::remove_dir_all(home);
}

/// 授权边界：源在授权根之外必须被拒绝。
#[test]
fn unauthorized_source_is_rejected() {
    let (home, access) = home_fixture("auth");
    let outside = temp_dir("auth-outside");
    let result = provision(&access, &home, &outside.to_string_lossy(), false);
    assert!(result.is_err(), "worktree 不应暴露未授权源");
    let _ = std::fs::remove_dir_all(home);
    let _ = std::fs::remove_dir_all(outside);
}

/// 目标目录名对同一源确定：slug+hash 不许漂移（会话恢复依赖它）。
#[test]
fn deterministic_path_for_same_source() {
    let (home, _access) = home_fixture("det");
    let root = home.join("project");
    std::fs::create_dir_all(&root).expect("建源目录");
    let name_a = deterministic_target_name(&root).expect("目标名 a");
    let name_b = deterministic_target_name(&root).expect("目标名 b");
    assert_eq!(name_a, name_b);
    let other = home.join("other");
    std::fs::create_dir_all(&other).expect("建其他目录");
    assert_ne!(
        deterministic_target_name(&root).unwrap(),
        deterministic_target_name(&other).unwrap()
    );
    let _ = std::fs::remove_dir_all(home);
}

/// worktree 根必须落在授权根 home 下；hack 一个指向根外路径的 release 要被拒。
#[test]
fn release_rejects_outside_worktree_base() {
    let (home, access) = home_fixture("release-out");
    let outside = temp_dir("release-outside");
    std::fs::write(outside.join("x.txt"), "x").expect("写外部文件");
    let root = home.join("project");
    std::fs::create_dir_all(&root).expect("建源目录");
    let dto = provision(&access, &home, &root.to_string_lossy(), false).expect("provision");
    // 同一授权根内、但不在 worktrees 基目录下的路径：拒绝（防删用户目录）
    let wrong = home.join("sessions");
    std::fs::create_dir_all(&wrong).expect("建目录");
    assert!(release(&access, &home, &wrong.to_string_lossy()).is_err());
    release(&access, &home, &dto.root).expect("正常 release");
    let _ = std::fs::remove_dir_all(home);
    let _ = std::fs::remove_dir_all(outside);
}

/// 一次都没派过隔离快照时列出空表（而不是报错）——设置页据此渲染「暂无快照」。
#[test]
fn list_empty_base_returns_empty() {
    let (home, _access) = home_fixture("list-empty");
    assert!(list(&home).expect("list").is_empty());
    let _ = std::fs::remove_dir_all(home);
}

/// provision 两个源后列出两条：kind / source / bytes 与快照实际内容对得上。
#[test]
fn list_reports_provisioned_snapshots() {
    let (home, access) = home_fixture("list-rows");
    let plain = home.join("project");
    std::fs::create_dir_all(&plain).expect("建源目录");
    std::fs::write(plain.join("x.txt"), "0123456789").expect("写文件");
    let repo = home.join("repo");
    std::fs::create_dir_all(&repo).expect("建仓库目录");
    init_repo(&repo);

    let copied =
        provision(&access, &home, &plain.to_string_lossy(), false).expect("provision 普通目录");
    let git_dto =
        provision(&access, &home, &repo.to_string_lossy(), false).expect("provision 仓库");

    let rows = list(&home).expect("list");
    assert_eq!(rows.len(), 2);
    // root 与 provision 返回值同形（都过 strip），前端才能原样回传 release
    let copy_row = rows
        .iter()
        .find(|row| row.root == copied.root)
        .expect("副本行");
    assert_eq!(copy_row.kind, "copy");
    assert_eq!(copy_row.source, strip(&plain));
    // 快照里除 x.txt 外还有一颗 provision 标记文件，故是「不小于」而非相等。
    assert!(copy_row.bytes >= 10, "副本至少含 x.txt 的 10 字节");
    let git_row = rows
        .iter()
        .find(|row| row.root == git_dto.root)
        .expect("git 行");
    assert_eq!(git_row.kind, "git");
    assert_eq!(git_row.source, strip(&repo));
    assert!(git_row.bytes > 0, "git 快照至少含检出的 a.txt");
    // root 升序稳定
    assert!(rows[0].root <= rows[1].root);
    let _ = std::fs::remove_dir_all(home);
}

/// 基目录里没有 provision 标记的目录不列 —— 不臆造 release 会拒收的条目。
#[test]
fn list_skips_unmarked_dirs() {
    let (home, _access) = home_fixture("list-stray");
    let base = store_fs::default_root(&home)
        .expect("default root")
        .join(WORKTREES_SUB_DIR);
    std::fs::create_dir_all(base.join("manual")).expect("建无标记目录");
    std::fs::write(base.join("loose.txt"), "not a dir").expect("建散文件");
    assert!(list(&home).expect("list").is_empty());
    let _ = std::fs::remove_dir_all(home);
}

/// release 后该条不再出现（回收面板刷新即可看到行消失）。
#[test]
fn list_drops_released_entry() {
    let (home, access) = home_fixture("list-release");
    let plain = home.join("project");
    std::fs::create_dir_all(&plain).expect("建源目录");
    std::fs::write(plain.join("x.txt"), "x\n").expect("写文件");
    let dto = provision(&access, &home, &plain.to_string_lossy(), false).expect("provision");
    assert_eq!(list(&home).expect("list").len(), 1);

    release(&access, &home, &dto.root).expect("release");

    assert!(list(&home).expect("list").is_empty());
    let _ = std::fs::remove_dir_all(home);
}

fn deterministic_target_name(source: &Path) -> Result<String, String> {
    deterministic_target(Path::new("/unused"), source)
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
}

/// 跑一条 git 子命令（测试辅助，忽略输出）。
fn git_in(root: &Path, args: &[&str]) {
    Command::new("git")
        .current_dir(root)
        .args(args)
        .status()
        .expect("git");
}

/// `.agents/linked` 里被忽略的文件会被符号链接进快照，且指向源文件。
#[cfg(unix)]
#[test]
fn linked_manifest_symlinks_ignored_files() {
    let (home, access) = home_fixture("linked");
    let repo = home.join("repo");
    std::fs::create_dir_all(&repo).expect("建仓库目录");
    init_repo(&repo);
    std::fs::write(repo.join(".gitignore"), ".env\n").expect("写 .gitignore");
    std::fs::create_dir_all(repo.join(".agents")).expect("建 .agents");
    std::fs::write(repo.join(".agents/linked"), "# 共享本地配置\n.env\n").expect("写 linked");
    std::fs::write(repo.join(".env"), "SECRET=1\n").expect("写 .env");
    // .env 被忽略、不进提交；清单与 .gitignore 进提交。
    git_in(&repo, &["add", "-A"]);
    git_in(&repo, &["commit", "-m", "add linked manifest"]);

    let dto = provision(&access, &home, &repo.to_string_lossy(), false).expect("provision");
    assert_eq!(dto.kind, "git");
    let link = PathBuf::from(&dto.root).join(".env");
    assert!(link.is_symlink(), ".env 应是符号链接");
    assert_eq!(
        std::fs::read_to_string(&link).expect("读链接内容"),
        "SECRET=1\n"
    );
    let _ = std::fs::remove_dir_all(home);
}

/// 未忽略 / 逃逸 / 缺失的条目一律跳过，不落链接。
#[cfg(unix)]
#[test]
fn linked_manifest_skips_unsafe_and_unignored_entries() {
    let (home, access) = home_fixture("linked-skip");
    let repo = home.join("repo");
    std::fs::create_dir_all(&repo).expect("建仓库目录");
    init_repo(&repo);
    std::fs::write(repo.join("tracked.txt"), "tracked\n").expect("写 tracked");
    std::fs::write(repo.join(".gitignore"), ".env\nmissing.env\n").expect("写 .gitignore");
    std::fs::create_dir_all(repo.join(".agents")).expect("建 .agents");
    std::fs::write(
        repo.join(".agents/linked"),
        ".env\ntracked.txt\n../escape\nmissing.env\n",
    )
    .expect("写 linked");
    std::fs::write(repo.join(".env"), "S=1\n").expect("写 .env");
    git_in(&repo, &["add", "-A"]);
    git_in(&repo, &["commit", "-m", "manifest"]);

    let dto = provision(&access, &home, &repo.to_string_lossy(), false).expect("provision");
    let target = PathBuf::from(&dto.root);
    assert!(target.join(".env").is_symlink(), "被忽略且存在的条目应链接");
    assert!(
        !target.join("tracked.txt").is_symlink(),
        "已跟踪条目应跳过（否则会污染 git status）"
    );
    assert!(
        !target.join("missing.env").exists(),
        "源中不存在的条目应跳过"
    );
    assert!(
        !home.join("escape").exists(),
        "逃逸条目不得在源树之外落链接"
    );
    let _ = std::fs::remove_dir_all(home);
}

/// 开启时 `.agents/prepare` 在新快照里执行（cwd = 快照）。
#[cfg(unix)]
#[test]
fn prepare_script_runs_when_enabled() {
    let (home, access) = home_fixture("prepare");
    let repo = home.join("repo");
    std::fs::create_dir_all(&repo).expect("建仓库目录");
    init_repo(&repo);
    std::fs::create_dir_all(repo.join(".agents")).expect("建 .agents");
    std::fs::write(
        repo.join(".agents/prepare"),
        "#!/bin/sh\ntouch prepared.marker\n",
    )
    .expect("写 prepare");
    git_in(&repo, &["add", "-A"]);
    git_in(&repo, &["commit", "-m", "add prepare"]);

    let dto = provision(&access, &home, &repo.to_string_lossy(), true).expect("provision");
    assert!(
        PathBuf::from(&dto.root).join("prepared.marker").is_file(),
        "prepare 应在快照里跑出产物"
    );
    let _ = std::fs::remove_dir_all(home);
}

/// 未开启（默认 / 只读档）时不执行 prepare。
#[cfg(unix)]
#[test]
fn prepare_skipped_when_disabled() {
    let (home, access) = home_fixture("prepare-off");
    let repo = home.join("repo");
    std::fs::create_dir_all(&repo).expect("建仓库目录");
    init_repo(&repo);
    std::fs::create_dir_all(repo.join(".agents")).expect("建 .agents");
    std::fs::write(
        repo.join(".agents/prepare"),
        "#!/bin/sh\ntouch prepared.marker\n",
    )
    .expect("写 prepare");
    git_in(&repo, &["add", "-A"]);
    git_in(&repo, &["commit", "-m", "add prepare"]);

    let dto = provision(&access, &home, &repo.to_string_lossy(), false).expect("provision");
    assert!(
        !PathBuf::from(&dto.root).join("prepared.marker").exists(),
        "未开启时不得执行 prepare"
    );
    let _ = std::fs::remove_dir_all(home);
}

/// prepare 失败只告警，不让 provision 整体失败（快照本身可用）。
#[cfg(unix)]
#[test]
fn prepare_failure_does_not_fail_provision() {
    let (home, access) = home_fixture("prepare-fail");
    let repo = home.join("repo");
    std::fs::create_dir_all(&repo).expect("建仓库目录");
    init_repo(&repo);
    std::fs::create_dir_all(repo.join(".agents")).expect("建 .agents");
    std::fs::write(repo.join(".agents/prepare"), "#!/bin/sh\nexit 3\n").expect("写 prepare");
    git_in(&repo, &["add", "-A"]);
    git_in(&repo, &["commit", "-m", "add prepare"]);

    let dto = provision(&access, &home, &repo.to_string_lossy(), true)
        .expect("prepare 失败不应让 provision 失败");
    assert!(PathBuf::from(&dto.root).is_dir());
    let _ = std::fs::remove_dir_all(home);
}

/// 路径安全判定：拒绝 `..` / 绝对路径 / 根目录，放行普通相对路径。
#[test]
fn safe_relative_rejects_escapes() {
    assert!(is_safe_relative(".env"));
    assert!(is_safe_relative("config/local.toml"));
    assert!(!is_safe_relative("../x"));
    assert!(!is_safe_relative("a/../../b"));
    assert!(!is_safe_relative("/etc/passwd"));
}
