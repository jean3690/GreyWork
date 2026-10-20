use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use crate::workspace_fs::WorkspaceFsAccess;

use super::dto::GitChangeDto;
use super::exec::run_capture;
use super::history::{
    log_history, parse_log_records, show_commit, validate_rev, LOG_FIELD_SEP, LOG_RECORD_SEP,
};
use super::ops::{branch_list, changes, commit, current_branch, diff, stage, status, unstage};
use super::path::validate_rel_path;
use super::porcelain::{
    letter_to_status, parse_numstat_line, parse_status_record, record_carries_old_path,
};

fn temp_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("系统时间早于 UNIX 纪元")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("greywork-git-{tag}-{nanos}"));
    std::fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

fn access(root: &Path) -> WorkspaceFsAccess {
    WorkspaceFsAccess::new(root, root.parent().unwrap().join("gw-git-access-test.json"))
        .expect("创建授权状态")
}

/// git 可用性探测（测试前置条件）。
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

/// 初始化并做一次初始提交，返回仓库根。
fn init_repo(tag: &str) -> PathBuf {
    git_available();
    let root = temp_dir(tag);
    Command::new("git")
        .current_dir(&root)
        .args(["init", "-q", "-b", "main"])
        .status()
        .expect("git init");
    // 提交需要作者身份。这里写**仓库级**配置，而不是给单条命令挂 GIT_AUTHOR_* 环境变量：
    // 被测的 commit() 是独立进程调用，拿不到测试进程的 env；而 CI runner 没有全局
    // user.name/user.email，只在个别命令上设环境变量会让 commit() 报
    // "Author identity unknown"（本机能过只是因为跑测的人配过全局身份）。
    for (key, value) in [
        ("user.name", "GreyWork Test"),
        ("user.email", "test@greywork.local"),
    ] {
        Command::new("git")
            .current_dir(&root)
            .args(["config", key, value])
            .status()
            .expect("git config");
    }
    std::fs::write(root.join(".gitignore"), "*.log\n").expect("写 gitignore");
    std::fs::write(root.join("a.txt"), "one\n").expect("写 a");
    std::fs::write(root.join("b.txt"), "hello\n").expect("写 b");
    Command::new("git")
        .current_dir(&root)
        .args(["add", "-A"])
        .status()
        .expect("git add");
    Command::new("git")
        .current_dir(&root)
        .args(["commit", "-m", "init"])
        .status()
        .expect("git commit");
    root
}

#[test]
fn status_parses_letters_and_staged_flag() {
    // 新签名返回 (index 位置码, worktree 位置码, 路径)
    assert_eq!(parse_status_record("M  a.txt").unwrap().0, 'M');
    assert_eq!(parse_status_record(" M a.txt").unwrap().1, 'M');
    assert_eq!(parse_status_record("A  a.txt").unwrap().0, 'A');
    assert_eq!(parse_status_record("?? a.txt").unwrap().0, '?');
    assert!(
        letter_to_status(' ').is_none(),
        "空白位置码表示这一侧没有改动"
    );
    assert_eq!(letter_to_status('M').unwrap(), "modified");
    assert_eq!(letter_to_status('?').unwrap(), "untracked");
    // 重命名记录在 -z 形态下就是 `R  <新路径>`，旧路径是下一条记录
    assert_eq!(parse_status_record("R  new.txt").unwrap().2, "new.txt");
    assert_eq!(parse_status_record("RM new.txt").unwrap().2, "new.txt");
    assert!(parse_status_record("not a status").is_none());
}

/// 路径含引号/反斜杠时 `-z` 原样输出，不该被当成转义序列吃掉。
#[test]
fn status_keeps_paths_verbatim_without_unescaping() {
    assert_eq!(
        parse_status_record(" M with\"quote.txt").unwrap().2,
        "with\"quote.txt"
    );
    assert_eq!(
        parse_status_record(" M with\\back.txt").unwrap().2,
        "with\\back.txt"
    );
    // 文件名里含 ` -> ` 也不会被切错（旧实现按 ` -> ` 切）
    assert_eq!(
        parse_status_record(" M a -> b.txt").unwrap().2,
        "a -> b.txt"
    );
}

/// 重命名/复制要连旧路径那条记录一起吃掉，否则会凭空多出一个文件。
#[test]
fn rename_records_consume_the_following_old_path() {
    assert!(record_carries_old_path("R  new.txt"));
    assert!(record_carries_old_path("C  copy.txt"));
    assert!(record_carries_old_path("RM new.txt"));
    assert!(!record_carries_old_path(" M a.txt"));
    assert!(!record_carries_old_path("?? a.txt"));
    assert!(!record_carries_old_path(""));
}

/// 端到端：真实仓库里的重命名与含引号的文件名都要解析对。
///
/// 这两条正是旧实现（按行 + 按 ` -> ` 切）会错的地方：重命名会把旧路径多报成一个文件，
/// 含引号的名字会带着引号与转义符返回。
#[test]
fn status_reports_rename_target_and_quoted_name_in_real_repo() {
    let root = init_repo("status-z");
    let access = access(&root);
    std::fs::write(root.join("a.txt"), "one\ntwo\n").expect("改 a");
    Command::new("git")
        .current_dir(&root)
        .args(["mv", "a.txt", "renamed.txt"])
        .status()
        .expect("git mv");
    // `"` 在 Windows 文件名里非法，含引号的用例仅在类 Unix 上跑。
    #[cfg(not(windows))]
    std::fs::write(root.join("with\"quote.txt"), "q\n").expect("写含引号的文件");

    let entries = status(&access, &root.to_string_lossy()).expect("采集状态");
    let paths: Vec<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();
    assert!(
        paths.contains(&"renamed.txt"),
        "重命名后的新路径要在: {paths:?}"
    );
    assert!(
        !paths.contains(&"a.txt"),
        "旧路径不该被当成独立条目: {paths:?}"
    );
    #[cfg(not(windows))]
    assert!(
        paths.contains(&"with\"quote.txt"),
        "含引号的文件名要原样返回: {paths:?}"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn numstat_parses_counts_and_rename_target() {
    assert_eq!(
        parse_numstat_line("3\t1\tpath/with space.txt").unwrap(),
        (3, 1, "path/with space.txt".into())
    );
    assert_eq!(
        parse_numstat_line("2\t0\told => new.txt").unwrap(),
        (2, 0, "new.txt".into())
    );
    // 花括号压缩形态：git 把公共前后缀抽到外面，直接按 `=>` 切会得到 `new}.txt`
    assert_eq!(
        parse_numstat_line("4\t2\tsrc/{old => new}.txt").unwrap(),
        (4, 2, "src/new.txt".into())
    );
    assert_eq!(
        parse_numstat_line("1\t0\t{a => b}.md").unwrap(),
        (1, 0, "b.md".into())
    );
    assert!(parse_numstat_line("x\ty\tz").is_none());
}

/// 分侧上报：同一个文件在 index 与 worktree 两侧各有改动时两边都要有状态与行数，
/// 且**不再相加**（旧实现把两侧行数求和，面板无法分区）。
#[test]
fn changes_reports_both_sides_separately() {
    let root = init_repo("changes-sides");
    std::fs::write(root.join("a.txt"), "one\ntwo\n").expect("改 a");
    Command::new("git")
        .current_dir(&root)
        .args(["add", "a.txt"])
        .status()
        .expect("git add");
    // 暂存之后再改一次：porcelain 变成 `MM`
    std::fs::write(root.join("a.txt"), "one\ntwo\nthree\n").expect("再改 a");
    let access = access(&root);

    let result = changes(&access, &root.to_string_lossy()).expect("采集变更");
    let a = result
        .iter()
        .find(|e| e.path == "a.txt")
        .expect("a 在变更里");
    assert_eq!(
        a.index.as_deref(),
        Some("modified"),
        "已跟踪文件改动后暂存 → M"
    );
    assert_eq!(a.worktree.as_deref(), Some("modified"));
    assert_eq!(a.staged_add, 1, "index 侧 1 行");
    assert_eq!(a.add, 1, "worktree 侧 1 行（不是两侧相加的 2）");

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn changes_reports_modified_added_and_counts() {
    let root = init_repo("changes");
    std::fs::write(root.join("a.txt"), "one\ntwo\n").expect("改 a");
    std::fs::write(root.join("new.txt"), "n\n").expect("写新文件");
    let access = access(&root);
    let result = changes(&access, &root.to_string_lossy()).expect("采集变更");
    let a = result
        .iter()
        .find(|e| e.path == "a.txt")
        .expect("a 在变更里");
    assert_eq!(a.worktree.as_deref(), Some("modified"));
    assert_eq!(a.index, None, "没暂存过，index 侧应无状态");
    assert_eq!(a.add, 1);
    assert_eq!(a.del, 0);
    let n = result
        .iter()
        .find(|e| e.path == "new.txt")
        .expect("new 在变更里");
    assert_eq!(n.worktree.as_deref(), Some("untracked"));
    assert_eq!(n.index, None, "`??` 不是「已暂存」");
    // untracked 不进 `git diff --numstat`（那是对已跟踪内容的统计），行数给 0，
    // 新增语义靠「新增(U)」徽标表达 —— 照实呈现，不猜行数。
    assert_eq!(n.add, 0);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn status_marks_staged_changes() {
    let root = init_repo("staged");
    std::fs::write(root.join("a.txt"), "one\none\n").expect("改 a");
    Command::new("git")
        .current_dir(&root)
        .args(["add", "a.txt"])
        .status()
        .expect("git add");
    let access = access(&root);
    let entries = status(&access, &root.to_string_lossy()).expect("采集状态");
    let a = entries
        .iter()
        .find(|e| e.path == "a.txt")
        .expect("a 在状态里");
    assert_eq!(a.status, "modified");
    assert!(a.staged);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn diff_reads_the_requested_side_only() {
    let root = init_repo("diff-arg");
    std::fs::write(root.join("a.txt"), "one\ntwo\n").expect("改 a");
    std::fs::write(root.join("b.txt"), "hello\nworld\n").expect("改 b");
    Command::new("git")
        .current_dir(&root)
        .args(["add", "b.txt"])
        .status()
        .expect("git add");
    let access = access(&root);
    let root_text = root.to_string_lossy().to_string();

    // 未暂存侧：只有 a（b 已进 index，不该出现在这一侧）
    let work = diff(&access, &root_text, None, false).expect("未暂存 diff");
    assert!(work.contains("a.txt"));
    assert!(
        !work.contains("b.txt"),
        "已暂存的文件不该出现在未暂存 diff 里"
    );

    // 已暂存侧：只有 b
    let staged = diff(&access, &root_text, None, true).expect("已暂存 diff");
    assert!(staged.contains("b.txt"));
    assert!(!staged.contains("a.txt"));

    // 单文件 + 指定侧
    let single = diff(&access, &root_text, Some("a.txt"), false).expect("单文件 diff");
    assert!(single.contains("a.txt"));
    assert!(!single.contains("b.txt"));

    // 越界路径与「- 开头」被拒（后者会被 git 当成选项）
    assert!(diff(&access, &root_text, Some("../outside.txt"), false).is_err());
    assert!(diff(&access, &root_text, Some("-p"), false).is_err());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn relative_path_validation_rejects_escapes_and_options() {
    assert!(validate_rel_path("a/b.txt").is_ok());
    assert!(validate_rel_path("带 空格/中文.md").is_ok());
    for bad in ["", "../x", "a/../../x", "/abs/x", "-p"] {
        assert!(validate_rel_path(bad).is_err(), "{bad:?} 应被拒绝");
    }
}

/// Windows 独有的绝对路径形态：`/abs/x` 有根无前缀（`is_absolute()` 漏掉的正是它），
/// `C:x` 有前缀无根，`C:\x` 与 `\\srv\share\x` 两者俱全 —— 四种都必须在 Windows 上被拒。
/// 由 windows job 的 `cargo test` 真正跑到（Linux 上这几串只是普通文件名，见下一个用例）。
#[cfg(windows)]
#[test]
fn relative_path_validation_rejects_windows_absolute_forms() {
    for bad in [r"/abs/x", r"C:x", r"C:\x", r"\\srv\share\x"] {
        assert!(validate_rel_path(bad).is_err(), "{bad:?} 应被拒绝");
    }
}

/// 反向约束：非 Windows 上 `C:x` / `a:b.txt` 就是合法文件名（ext4/APFS 都允许冒号），
/// 校验器靠 `Path` 的平台语义判定，不该把它们连坐拒掉 —— 否则这类文件在变更面板里
/// 永远暂存不了。这条用例钉住「按平台语义而非字符串模式匹配」这个实现选择。
#[cfg(not(windows))]
#[test]
fn relative_path_validation_keeps_colon_filenames_outside_windows() {
    for ok in [r"C:x", "a:b.txt"] {
        assert!(
            validate_rel_path(ok).is_ok(),
            "{ok:?} 在非 Windows 上是普通文件名"
        );
    }
}

#[test]
fn stage_and_unstage_move_changes_between_sides() {
    let root = init_repo("stage-unstage");
    std::fs::write(root.join("a.txt"), "one\none\n").expect("改 a");
    let access = access(&root);
    let root_text = root.to_string_lossy().to_string();

    let read_a = || -> GitChangeDto {
        changes(&access, &root_text)
            .expect("变更")
            .into_iter()
            .find(|entry| entry.path == "a.txt")
            .expect("a 在变更里")
    };

    stage(&access, &root_text, &["a.txt".into()], false).expect("暂存 a");
    let staged = read_a();
    assert_eq!(staged.index.as_deref(), Some("modified"));
    assert_eq!(staged.worktree, None, "暂存后 worktree 侧应干净");

    unstage(&access, &root_text, &["a.txt".into()], false).expect("取消暂存");
    let unstaged = read_a();
    assert_eq!(unstaged.index, None);
    assert_eq!(unstaged.worktree.as_deref(), Some("modified"));

    // 全部暂存 / 全部取消
    stage(&access, &root_text, &[], true).expect("全部暂存");
    assert!(changes(&access, &root_text)
        .expect("变更")
        .iter()
        .all(|entry| entry.worktree.is_none()));
    unstage(&access, &root_text, &[], true).expect("全部取消");
    assert!(changes(&access, &root_text)
        .expect("变更")
        .iter()
        .all(|entry| entry.index.is_none()));

    let _ = std::fs::remove_dir_all(root);
}

/// 没有任何提交的仓库：`git restore --staged` 会报 `could not resolve HEAD`，
/// 必须回落 `git rm --cached`。
#[test]
fn unstage_works_on_a_repo_without_commits() {
    git_available();
    let root = temp_dir("unborn");
    Command::new("git")
        .current_dir(&root)
        .args(["init", "-q", "-b", "main"])
        .status()
        .expect("git init");
    std::fs::write(root.join("a.txt"), "a\n").expect("写文件");
    let access = access(&root);
    let root_text = root.to_string_lossy().to_string();

    stage(&access, &root_text, &["a.txt".into()], false).expect("暂存");
    unstage(&access, &root_text, &["a.txt".into()], false).expect("取消暂存（unborn HEAD）");

    let entry = changes(&access, &root_text)
        .expect("变更")
        .into_iter()
        .find(|entry| entry.path == "a.txt")
        .expect("a 在变更里");
    assert_eq!(entry.index, None, "索引里应已拿掉");
    assert_eq!(entry.worktree.as_deref(), Some("untracked"));
    let _ = std::fs::remove_dir_all(root);
}

/// 重命名要成对取消暂存：只 reset 新路径会在索引里留下一条「旧路径已删除」的幽灵。
#[test]
fn unstage_pairs_the_old_path_of_a_rename() {
    let root = init_repo("unstage-rename");
    Command::new("git")
        .current_dir(&root)
        .args(["mv", "a.txt", "renamed.txt"])
        .status()
        .expect("git mv");
    let access = access(&root);
    let root_text = root.to_string_lossy().to_string();

    let entry = changes(&access, &root_text)
        .expect("变更")
        .into_iter()
        .find(|entry| entry.path == "renamed.txt")
        .expect("重命名条目");
    assert_eq!(entry.index.as_deref(), Some("renamed"));
    assert_eq!(entry.old_path.as_deref(), Some("a.txt"));

    unstage(&access, &root_text, &["renamed.txt".into()], false).expect("取消暂存重命名");
    let remaining = changes(&access, &root_text).expect("变更");
    assert!(
        remaining.iter().all(|entry| entry.index.is_none()),
        "索引侧应彻底干净: {remaining:?}"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn commit_makes_hash_and_clears_changes() {
    let root = init_repo("commit");
    std::fs::write(root.join("a.txt"), "one\none\none\n").expect("改 a");
    let access = access(&root);
    // all = true：保留旧的「提交全部」语义（先 add -A）
    let result = commit(&access, &root.to_string_lossy(), "改动 a", true).expect("提交");
    assert_eq!(result.message, "改动 a");
    assert!(!result.hash.is_empty());
    assert!(!result.timestamp.is_empty());
    let remaining = status(&access, &root.to_string_lossy()).expect("提交后状态");
    assert!(remaining.is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn commit_rejects_blank_message() {
    let root = init_repo("blank-msg");
    let access = access(&root);
    assert!(commit(&access, &root.to_string_lossy(), "   ", true).is_err());
    let _ = std::fs::remove_dir_all(root);
}

/// 只提交已暂存：索引为空时给中文文案（而不是转发 git 的英文
/// `no changes added to commit`），暂存之后才提交得了。
#[test]
fn commit_staged_only_requires_a_staged_index() {
    let root = init_repo("commit-staged");
    std::fs::write(root.join("a.txt"), "one\none\n").expect("改 a");
    let access = access(&root);
    let root_text = root.to_string_lossy().to_string();

    let error = commit(&access, &root_text, "只提交暂存", false).expect_err("索引为空应被拒");
    assert_eq!(error, "没有已暂存的变更");

    stage(&access, &root_text, &["a.txt".into()], false).expect("暂存");
    let result = commit(&access, &root_text, "只提交暂存", false).expect("提交");
    assert_eq!(result.message, "只提交暂存");
    assert!(status(&access, &root_text).expect("提交后状态").is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn branches_and_current_branch() {
    let root = init_repo("branch");
    Command::new("git")
        .current_dir(&root)
        .args(["checkout", "-q", "-b", "feature/x"])
        .status()
        .expect("切分支");
    let access = access(&root);
    assert_eq!(
        current_branch(&access, &root.to_string_lossy()).expect("当前分支"),
        "feature/x"
    );
    let list = branch_list(&access, &root.to_string_lossy()).expect("分支列表");
    assert!(list.contains(&"feature/x".to_string()));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn non_git_directory_is_a_clear_error() {
    let root = temp_dir("not-a-repo");
    let access = access(&root);
    let result = status(&access, &root.to_string_lossy());
    assert!(result.is_err());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn sibling_directory_is_rejected_by_authorization() {
    git_available();
    let root = temp_dir("auth");
    let outside = temp_dir("auth-outside");
    std::fs::write(outside.join("x.txt"), "x").expect("写外部文件");
    let access = access(&root);
    let result = status(&access, &outside.to_string_lossy());
    assert!(result.is_err());
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(outside);
}

#[test]
fn run_capture_collects_stdout() {
    git_available();
    let mut cmd = Command::new("git");
    cmd.arg("--version");
    let output = run_capture(&mut cmd, Duration::from_secs(10)).expect("git --version");
    assert!(output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("git version"),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
}

/// 到点未退的进程被整组杀掉并以超时报错返回，而不是无限等待。
#[cfg(unix)]
#[test]
fn run_capture_times_out_and_kills() {
    let mut cmd = Command::new("sleep");
    cmd.arg("30");
    let started = Instant::now();
    let error = run_capture(&mut cmd, Duration::from_millis(200)).expect_err("应当超时");
    assert!(error.contains("超时"), "{error}");
    // 关键：必须接近超时窗口就返回，而不是等 sleep 自己跑完 30s。
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "耗时 {:?}",
        started.elapsed()
    );
}

/// 输出超过管道缓冲（64KB）也不会死锁 —— 读线程抽干管道，子进程能一路写到底。
#[cfg(unix)]
#[test]
fn run_capture_drains_large_output() {
    let mut cmd = Command::new("sh");
    cmd.args(["-c", "head -c 200000 /dev/zero | tr '\\0' 'a'"]);
    let output = run_capture(&mut cmd, Duration::from_secs(10)).expect("大输出");
    assert!(output.status.success());
    assert_eq!(output.stdout.len(), 200_000);
}

#[test]
fn parse_log_records_reads_fields_and_keeps_subject_whole() {
    let us = LOG_FIELD_SEP;
    let rs = LOG_RECORD_SEP;
    let out = format!(
        "abc{us}abc123{us}Ana{us}a@x.com{us}2026-01-01T10:00:00+08:00{us}fix: 标题{us}HEAD -> main, tag: v1{rs}\n\
         def{us}def456{us}Bob{us}b@x.com{us}2026-01-02T10:00:00+08:00{us}带{us}US 的主题{us}{rs}\n"
    );
    let commits = parse_log_records(&out);
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[0].hash, "abc");
    assert_eq!(commits[0].short_hash, "abc123");
    assert_eq!(commits[0].author, "Ana");
    assert_eq!(commits[0].email, "a@x.com");
    assert_eq!(commits[0].timestamp, "2026-01-01T10:00:00+08:00");
    assert_eq!(commits[0].subject, "fix: 标题");
    assert_eq!(commits[0].refs, "HEAD -> main, tag: v1");
    // 主题里混进字段分隔符也要整体保留，不能把 refs 切错位。
    assert_eq!(commits[1].subject, format!("带{us}US 的主题"));
    assert_eq!(commits[1].refs, "");
}

#[test]
fn parse_log_records_ignores_empty_and_short_records() {
    assert!(parse_log_records("").is_empty());
    assert!(parse_log_records("\u{1e}\n").is_empty());
    assert!(parse_log_records("only\u{1f}five\u{1f}fields\u{1f}here\u{1e}").is_empty());
}

#[test]
fn validate_rev_accepts_hex_and_rejects_option_like() {
    assert!(validate_rev("a1b2c3").is_ok());
    assert!(validate_rev(&"0".repeat(64)).is_ok(), "SHA-256 仓库");
    assert!(validate_rev("").is_err());
    assert!(validate_rev("--all").is_err());
    assert!(validate_rev("HEAD~1").is_err());
}

#[test]
fn log_and_show_read_history_newest_first() {
    git_available();
    let root = init_repo("history");
    std::fs::write(root.join("b.txt"), "hello\nworld\n").expect("改 b");
    Command::new("git")
        .current_dir(&root)
        .args(["add", "-A"])
        .status()
        .expect("git add");
    Command::new("git")
        .current_dir(&root)
        .args(["commit", "-m", "second"])
        .status()
        .expect("git commit");
    let access = access(&root);

    let commits = log_history(&access, &root.to_string_lossy(), None, None).expect("log");
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[0].subject, "second");
    assert_eq!(commits[1].subject, "init");
    assert!(!commits[0].refs.is_empty(), "HEAD 应带引用装饰");

    let patch =
        show_commit(&access, &root.to_string_lossy(), &commits[0].hash, None).expect("show");
    assert!(
        patch.trim_start().starts_with("diff --git"),
        "不该带提交头：{patch}"
    );
    assert!(patch.contains("+world"), "{patch}");

    // 分页：skip 1、limit 1 → 只剩 init。
    let page = log_history(&access, &root.to_string_lossy(), Some(1), Some(1)).expect("log 分页");
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].subject, "init");

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn log_on_a_repo_without_commits_is_empty_not_an_error() {
    git_available();
    let root = temp_dir("unborn-log");
    Command::new("git")
        .current_dir(&root)
        .args(["init", "-q", "-b", "main"])
        .status()
        .expect("git init");
    let access = access(&root);
    let commits = log_history(&access, &root.to_string_lossy(), None, None).expect("log");
    assert!(commits.is_empty());
    let _ = std::fs::remove_dir_all(root);
}
