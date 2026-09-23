//! 工作区 Git 操作（变更状态 / diff / 提交 / 分支），全部经宿主 git CLI 执行。
//!
//! 边界与安全：
//! - 只允许在**已经授权的根目录**内运行 git（复用 `WorkspaceFsAccess` 的授权账本）；
//!   渲染端不能拿任意路径来跑 `git -C` —— 路径先经 `resolve_existing` 解析成规范路径。
//! - 参数一律走 argv 数组（无 shell 拼接），路径/消息里的引号、空格、`--` 都不会被解释。
//! - `GIT_TERMINAL_PROMPT=0`：本模块是只读查询 + 明确请求的提交，绝不让 git 挂起等人输入。
//! - `core.quotepath=false`：路径按 UTF-8 原样输出，前端不用解码 `\303\251` 转义。
//! - `color.ui=never`：diff 不带 ANSI 色码，前端自行着色（`lib/unified-diff`）。
//!
//! 目标产物：`git status --porcelain` 的 XY 码 → 类型化变更条目；`--numstat` 补行级
//! 增删；`git diff` 给统一 diff 文本；`git commit` 提交全部暂存变更并回收短 hash。

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::workspace_fs::WorkspaceFsAccess;

const GIT: &str = "git";

/// git 子命令的超时上限。
///
/// 巨型仓库（或冷缓存、网络盘）上的 `status` / `diff` 可能长时间不出结果，而渲染端的
/// `await invoke(...)` 没有超时窗口 —— 无上限就等于把「卡死」表现成永久转圈。到点整组
/// 杀进程并报错，让 UI 至少能恢复。取 30s：覆盖正常的大仓库查询，又不至于让用户白等太久。
const GIT_TIMEOUT: Duration = Duration::from_secs(30);

/* ===== 类型化输出 DTO（camelCase 对齐前端 GitService 接口） ===== */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusDto {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

/// 变更条目。
///
/// **两侧分开报**：同一个文件可以同时有「已暂存」和「未暂存」的改动（porcelain 里的 `MM`），
/// 而提交只吃 index 侧、行数也只该按侧统计 —— 旧的单 `staged` 布尔 + 两侧相加既表达不了
/// 这种状态，也让变更面板无法分区展示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangeDto {
    pub path: String,
    /// 重命名 / 复制的旧路径。取消暂存要成对处理，否则索引里会留下一条
    /// 「旧路径已删除」的幽灵变更。
    pub old_path: Option<String>,
    /// index（已暂存）侧的状态；`None` = 这一侧没有改动。
    pub index: Option<String>,
    /// worktree（未暂存）侧的状态；`None` = 这一侧没有改动。
    pub worktree: Option<String>,
    /// index 侧的行级增删。
    pub staged_add: u32,
    pub staged_del: u32,
    /// worktree 侧的行级增删。
    pub add: u32,
    pub del: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResultDto {
    pub hash: String,
    pub message: String,
    pub timestamp: String,
}

/// 一条历史提交的元信息（不含 diff 正文 —— 正文由 `git_show` 按需取）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDto {
    /// 完整 hash。
    pub hash: String,
    /// 短 hash（`git log` 常用展示形态）。
    pub short_hash: String,
    pub author: String,
    pub email: String,
    /// committer date，ISO 8601（带时区偏移，便于渲染端本地化）。
    pub timestamp: String,
    /// 提交主题（消息首行）。
    pub subject: String,
    /// 指向这条提交的引用（`%D` 原样，如 `HEAD -> main, origin/main, tag: v1.0`；空则无）。
    pub refs: String,
}

/* ===== 底层执行 ===== */

/// 跑一个已配置好的命令并收 stdout/stderr，超过 `timeout` 未退则整组杀进程。
///
/// **为什么不用 `.output()`**：它既没有超时窗口，也会在管道写满而调用方还没开始读时死锁
/// （`git diff` 大文件轻易超过 64KB 管道缓冲）。这里 stdout/stderr 各起一个读线程把管道
/// 抽干，主线程只轮询退出状态 —— 到点用 `kill_process_tree` 回收整组，读线程随管道关闭自然收尾。
///
/// Unix 上 spawn 前自成进程组（`process_group(0)`）：`kill_process_tree` 的契约要求 pid
/// 就是组长，否则 killpg 会 ESRCH 而静默留下残留进程。
fn run_capture(cmd: &mut Command, timeout: Duration) -> Result<std::process::Output, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let program = cmd.get_program().to_string_lossy().into_owned();
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("无法启动 {program}: {error}"))?;
    let mut out_pipe = child.stdout.take().expect("stdout 已设为 piped");
    let mut err_pipe = child.stderr.take().expect("stderr 已设为 piped");
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out_pipe.read_to_end(&mut buf);
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err_pipe.read_to_end(&mut buf);
        buf
    });

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    crate::process_guard::kill_process_tree(child.id());
                    break child
                        .wait()
                        .map_err(|error| format!("等待进程退出失败: {error}"))?;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(error) => return Err(format!("等待进程退出失败: {error}")),
        }
    };

    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    if timed_out {
        return Err(format!(
            "命令超时（超过 {} 秒未返回），已中止执行",
            timeout.as_secs()
        ));
    }
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

/// 在授权根内执行 git；失败返回 stderr（去尾空白）。绝不弹出交互提示，且有超时上限。
fn run_git(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(GIT);
    // Windows 上隐藏控制台窗口（GUI 程序 spawn 控制台程序会闪黑框）。
    // 只隐藏、不 detach：下面同步收 stdio。
    crate::process_guard::hide_console_std(&mut cmd);
    cmd.current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        // 只读操作不升级索引/引用（避免后台还挂着别的 git 时搬走锁文件）
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(["-c", "core.quotepath=false", "-c", "color.ui=never"])
        .args(args);
    let output = run_capture(&mut cmd, GIT_TIMEOUT)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr)
            .trim_end()
            .to_string();
        let stdout = String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string();
        if stderr.is_empty() {
            Err(stdout)
        } else {
            Err(stderr)
        }
    }
}

/// X/Y 两个位置码（staged/worktree）中的非空白码 → 类型化状态；空白 = 无改动。
fn letter_to_status(letter: char) -> Option<String> {
    Some(
        match letter {
            'M' | 'm' => "modified",
            'A' => "added",
            'D' => "deleted",
            'R' | 'r' | 'C' | 'c' => "renamed",
            'T' => "modified",
            'U' | '?' => "untracked",
            _ => return None,
        }
        .to_string(),
    )
}

/// 一条 porcelain 记录：路径 + （重命名 / 复制时的）旧路径 + XY 两个位置码。
#[derive(Debug)]
struct StatusRecord {
    path: String,
    old_path: Option<String>,
    /// X：index（已暂存）侧的位置码。
    index: char,
    /// Y：worktree（未暂存）侧的位置码。
    worktree: char,
}

/// 解析 `git status --porcelain -z` 的一条记录头（`XY <路径>`）。
///
/// 只解析这一条；重命名 / 复制的**旧路径是紧随其后的另一条记录**，由 `collect_records` 拼上。
///
/// 用 `-z` 形态而不是默认的行形态：`-z` 下路径**原样输出**（不引号、不转义），
/// 重命名/复制的两条路径以 NUL 分隔而不是 ` -> ` 拼接。这样既省掉一整套 C 风格解转义
/// （`core.quotepath=false` 只关掉非 ASCII 的八进制转义，含 `"` / `\` 的路径仍会被
/// 引号包裹），也不会被文件名里恰好含 ` -> ` 的情况骗到。
fn parse_status_record(record: &str) -> Option<(char, char, String)> {
    let bytes = record.as_bytes();
    if bytes.len() < 3 || bytes[2] != b' ' {
        return None;
    }
    let path = record[3..].to_string();
    if path.is_empty() {
        return None;
    }
    Some((bytes[0] as char, bytes[1] as char, path))
}

/// `-z` 下重命名/复制的 index 字母：后面还会跟一条「旧路径」记录，必须跳过。
fn record_carries_old_path(record: &str) -> bool {
    matches!(record.as_bytes().first(), Some(b'R' | b'C'))
}

/// `git status --porcelain -z` 的全部记录（含重命名配对）。
fn collect_records(root: &Path) -> Result<Vec<StatusRecord>, String> {
    let out = run_git(root, &["status", "--porcelain", "-z"])?;
    let mut records = out.split('\0');
    let mut entries = Vec::new();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        // 先决定要不要吃掉下一条（旧路径），再做状态校验 —— 校验失败时也不能让
        // 旧路径被当成一条独立记录（那样会凭空多出一个文件）。
        let old_path = if record_carries_old_path(record) {
            records.next().map(str::to_string)
        } else {
            None
        };
        if let Some((index, worktree, path)) = parse_status_record(record) {
            entries.push(StatusRecord {
                path,
                old_path,
                index,
                worktree,
            });
        }
    }
    Ok(entries)
}

/// `git status --porcelain` 全部条目的类型化列表。
fn collect_status(root: &Path) -> Result<Vec<GitStatusDto>, String> {
    Ok(collect_records(root)?
        .into_iter()
        .filter_map(|record| {
            let status =
                letter_to_status(record.index).or_else(|| letter_to_status(record.worktree))?;
            Some(GitStatusDto {
                path: record.path,
                status,
                staged: !matches!(record.index, ' ' | '?' | '!'),
            })
        })
        .collect())
}

/// 解析 `--numstat` 的一行（`added\tdeleted\tpath`）。
///
/// 重命名时路径有两种形态，都要取到**新路径**：
/// - `old => new.txt`（前后缀无公共部分）
/// - `dir/{old => new}.txt`（git 把公共前后缀抽到花括号外 —— 这是最容易切错的一种，
///   直接按 `=>` 切会得到 `new}.txt`）
fn parse_numstat_line(line: &str) -> Option<(u32, u32, String)> {
    let mut parts = line.split('\t');
    let add = parts.next()?.parse().ok()?;
    let del = parts.next()?.parse().ok()?;
    let path = parts.next()?.trim();
    if path.is_empty() {
        return None;
    }
    Some((add, del, rename_target(path)))
}

/// 行式 numstat 的路径 → 新路径。非重命名原样返回。
fn rename_target(path: &str) -> String {
    let Some((before, after)) = path.split_once(" => ") else {
        return path.to_string();
    };
    let Some(open) = before.rfind('{') else {
        return after.trim().to_string();
    };
    match after.find('}') {
        Some(close) => format!("{}{}{}", &before[..open], &after[..close], &after[close + 1..]),
        // 花括号没闭合：不猜，退化成「取箭头右边」。
        None => after.trim().to_string(),
    }
}

fn collect_numstat(root: &Path, cached: bool) -> Result<Vec<(u32, u32, String)>, String> {
    let args: &[&str] = if cached {
        &["diff", "--cached", "--numstat"]
    } else {
        &["diff", "--numstat"]
    };
    let out = run_git(root, args)?;
    Ok(out.lines().filter_map(parse_numstat_line).collect())
}

/// 从一张 numstat 表里取某路径的行级增删；没有就返回 0。
fn numstat_of(list: &[(u32, u32, String)], path: &str) -> (u32, u32) {
    list.iter()
        .find(|(_, _, candidate)| candidate == path)
        .map(|(add, del, _)| (*add, *del))
        .unwrap_or((0, 0))
}

/* ===== 命令实现 ===== */

fn resolve_root(access: &WorkspaceFsAccess, raw: &str) -> Result<PathBuf, String> {
    let path = access.resolve_existing(raw)?;
    let metadata =
        std::fs::metadata(&path).map_err(|error| format!("读取目录元数据失败: {error}"))?;
    if !metadata.is_dir() {
        return Err("git 根必须是目录".into());
    }
    Ok(path)
}

/// 变更状态列表（status），供变更面板展示。
fn status(access: &WorkspaceFsAccess, root: &str) -> Result<Vec<GitStatusDto>, String> {
    collect_status(&resolve_root(access, root)?)
}

/// status + 每文件**分侧**的行级增删。
fn changes(access: &WorkspaceFsAccess, root: &str) -> Result<Vec<GitChangeDto>, String> {
    let root = resolve_root(access, root)?;
    let records = collect_records(&root)?;
    let unstaged = collect_numstat(&root, false)?;
    let staged = collect_numstat(&root, true)?;
    Ok(records
        .into_iter()
        .map(|record| {
            let (work_add, work_del) = numstat_of(&unstaged, &record.path);
            let (staged_add, staged_del) = numstat_of(&staged, &record.path);
            GitChangeDto {
                path: record.path,
                old_path: record.old_path,
                // `??`（未跟踪）只在 worktree 侧有意义：index 侧的 `?` 不是「已暂存」。
                index: if record.index == '?' {
                    None
                } else {
                    letter_to_status(record.index)
                },
                worktree: letter_to_status(record.worktree),
                staged_add,
                staged_del,
                add: work_add,
                del: work_del,
            }
        })
        .collect())
}

/// 渲染端传来的**仓库相对路径**校验：必须相对、不含 `..`、不以 `-` 开头。
///
/// 参数走 argv 数组，不存在 shell 解释；这里防的是「`-` 开头被 git 当成选项」以及
/// 「路径越出仓库」这两件事。非 ASCII 不受影响（argv 按字节传，`core.quotepath`
/// 只影响输出）。
fn validate_rel_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("路径不能为空".into());
    }
    if path.starts_with('-') {
        return Err(format!("非法路径: {path}"));
    }
    let candidate = Path::new(path);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(format!("非法路径: {path}"));
    }
    Ok(())
}

/// 统一 diff：`staged` 为真看 index（已暂存）侧，否则看 worktree（未暂存）侧；
/// `path` 缺省为全量。
///
/// **两侧不再拼接**：变更面板现在按「已暂存 / 未暂存」分区展示，拼在一起就分不清
/// 哪段属于哪一侧了（旧实现把两段 diff 直接接起来，正是这个问题的来源）。
fn diff(
    access: &WorkspaceFsAccess,
    root: &str,
    path: Option<&str>,
    staged: bool,
) -> Result<String, String> {
    let root = resolve_root(access, root)?;
    let mut args: Vec<&str> = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    if let Some(path) = path {
        validate_rel_path(path)?;
        args.push("--");
        args.push(path);
    }
    run_git(&root, &args)
}

/// index 里有没有已暂存的改动。
///
/// 用「`--name-only` 输出是否为空」判断，而不是去匹配 git 的英文报错
/// （`no changes added to commit` 这类文案随版本变，也被 locale 影响）。
fn has_staged_changes(root: &Path) -> Result<bool, String> {
    Ok(!run_git(root, &["diff", "--cached", "--name-only"])?
        .trim()
        .is_empty())
}

/// 暂存：`all` 走 `add -A`，否则只 add 指定路径（**必须带 `--`**，防 `-` 开头被当选项）。
fn stage(
    access: &WorkspaceFsAccess,
    root: &str,
    paths: &[String],
    all: bool,
) -> Result<(), String> {
    let root = resolve_root(access, root)?;
    if all {
        run_git(&root, &["add", "-A"]).map_err(|error| format!("暂存变更失败: {error}"))?;
        return Ok(());
    }
    if paths.is_empty() {
        return Err("没有指定要暂存的文件".into());
    }
    let mut args: Vec<&str> = vec!["add", "--"];
    for path in paths {
        validate_rel_path(path)?;
        args.push(path);
    }
    run_git(&root, &args).map_err(|error| format!("暂存变更失败: {error}"))?;
    Ok(())
}

/// 取消暂存。
///
/// 两个坑：
/// - **未提交仓库（unborn HEAD）没有 HEAD 可 reset**，`git restore --staged` 会报
///   `could not resolve HEAD`；这种仓库回落 `git rm --cached -r`（本来就什么都还没进过提交，
///   「取消暂存」等价于「从索引里拿掉」）。
/// - **重命名要成对处理**：只 reset 新路径会留下一条「旧路径已删除」的索引条目，
///   界面上就是一个删不掉的幽灵变更。
fn unstage(
    access: &WorkspaceFsAccess,
    root: &str,
    paths: &[String],
    all: bool,
) -> Result<(), String> {
    let root = resolve_root(access, root)?;
    let has_head = run_git(&root, &["rev-parse", "--verify", "HEAD"]).is_ok();
    let mut targets: Vec<String> = Vec::new();
    if !all {
        if paths.is_empty() {
            return Err("没有指定要取消暂存的文件".into());
        }
        targets = expand_renames(&root, paths)?;
    }

    let mut args: Vec<&str> = if has_head {
        vec!["restore", "--staged"]
    } else {
        vec!["rm", "--cached", "-r", "-q"]
    };
    args.push("--");
    if all {
        args.push(".");
    } else {
        for path in &targets {
            args.push(path);
        }
    }
    run_git(&root, &args).map_err(|error| format!("取消暂存失败: {error}"))?;
    Ok(())
}

/// 把要取消暂存的路径补成「新路径 + 重命名前的旧路径」，并按同一套规则校验。
fn expand_renames(root: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    let records = collect_records(root)?;
    let mut out: Vec<String> = Vec::new();
    for path in paths {
        validate_rel_path(path)?;
        out.push(path.clone());
        if let Some(record) = records.iter().find(|record| &record.path == path) {
            if let Some(old) = &record.old_path {
                out.push(old.clone());
            }
        }
    }
    Ok(out)
}

/// 提交。`all: true` = 先 `add -A` 再提交（旧的「提交全部」行为）；
/// `all: false` = 只提交已暂存的内容，索引为空时给出中文文案而不是 git 的英文报错。
fn commit(
    access: &WorkspaceFsAccess,
    root: &str,
    message: &str,
    all: bool,
) -> Result<CommitResultDto, String> {
    let root = resolve_root(access, root)?;
    let message = message.trim();
    if message.is_empty() {
        return Err("提交信息不能为空".into());
    }
    if all {
        run_git(&root, &["add", "-A"]).map_err(|error| format!("暂存变更失败: {error}"))?;
    } else if !has_staged_changes(&root)? {
        return Err("没有已暂存的变更".into());
    }
    run_git(&root, &["commit", "-m", message]).map_err(|error| {
        if error.contains("nothing to commit") {
            "没有可提交的变更".into()
        } else {
            format!("提交失败: {error}")
        }
    })?;
    let hash = run_git(&root, &["rev-parse", "--short", "HEAD"])?
        .trim()
        .to_string();
    let timestamp = run_git(&root, &["show", "-s", "--format=%cI", "HEAD"])?
        .trim()
        .to_string();
    Ok(CommitResultDto {
        hash,
        message: message.to_string(),
        timestamp,
    })
}

fn current_branch(access: &WorkspaceFsAccess, root: &str) -> Result<String, String> {
    Ok(
        run_git(&resolve_root(access, root)?, &["branch", "--show-current"])?
            .trim()
            .to_string(),
    )
}

fn branch_list(access: &WorkspaceFsAccess, root: &str) -> Result<Vec<String>, String> {
    let out = run_git(
        &resolve_root(access, root)?,
        &["branch", "--format=%(refname:short)"],
    )?;
    Ok(out
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(String::from)
        .collect())
}

/* ===== 提交历史 ===== */

/// 单次 `git log` 的默认 / 最大条数。
///
/// 上限不是怕 git 慢，而是怕渲染端一次塞进几千条（虚拟列表也扛不住首帧构建）。
/// 需要更多就分页（`skip`）。
const LOG_LIMIT_DEFAULT: u32 = 50;
const LOG_LIMIT_MAX: u32 = 200;

/// 字段分隔符（US，0x1F）与记录分隔符（RS，0x1E）：提交主题可含任意可见字符，
/// 用控制字符当分隔才能避免被「主题里恰好有个逗号/竖线」切错。
const LOG_FIELD_SEP: char = '\u{1f}';
const LOG_RECORD_SEP: char = '\u{1e}';

/// git log 的输出模板：hash / 短 hash / 作者 / 邮箱 / 提交日期 / 主题 / 引用。
/// 分隔符用 git 的 `%x1f`（US，字段）/ `%x1e`（RS，记录）转义写出。
const LOG_FORMAT: &str = "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%cI%x1f%s%x1f%D%x1e";

/// 解析 `log_format()` 的输出。
///
/// **末尾 refs 定长、中间 subject 用 join 兜底**：`%s`（主题）理论上可含 US，若按位置
/// 取字段会错位。取「前 5 个前缀字段 + 末尾 refs，中间剩下的整体当 subject」——只有主题
/// 含 RS 时才会真错位，那比含 US 更罕见。字段不足 6 个视为坏记录跳过。
fn parse_log_records(out: &str) -> Vec<GitCommitDto> {
    out.split(LOG_RECORD_SEP)
        .filter_map(|record| {
            // git 在每条记录后补一个 `\n`，切分后下一条会带前导换行。
            let record = record.trim_matches('\n');
            if record.is_empty() {
                return None;
            }
            let parts: Vec<&str> = record.split(LOG_FIELD_SEP).collect();
            if parts.len() < 6 {
                return None;
            }
            let refs = parts[parts.len() - 1].trim().to_string();
            let subject = parts[5..parts.len() - 1].join(&LOG_FIELD_SEP.to_string());
            Some(GitCommitDto {
                hash: parts[0].to_string(),
                short_hash: parts[1].to_string(),
                author: parts[2].to_string(),
                email: parts[3].to_string(),
                timestamp: parts[4].to_string(),
                subject,
                refs,
            })
        })
        .collect()
}

/// 提交历史（新 → 旧）。
///
/// 未提交仓库（unborn HEAD）没有 HEAD 可遍历，`git log` 会报 `does not have any commits
/// yet`；这不是错误，返回空列表让界面显示「暂无提交」，与「仓库干净」区分开的是列表本身。
fn log_history(
    access: &WorkspaceFsAccess,
    root: &str,
    limit: Option<u32>,
    skip: Option<u32>,
) -> Result<Vec<GitCommitDto>, String> {
    let root = resolve_root(access, root)?;
    if run_git(&root, &["rev-parse", "--verify", "HEAD"]).is_err() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(LOG_LIMIT_DEFAULT).clamp(1, LOG_LIMIT_MAX);
    let skip = skip.unwrap_or(0);
    let max_count = format!("--max-count={limit}");
    let skip_arg = format!("--skip={skip}");
    let out = run_git(&root, &["log", &max_count, &skip_arg, LOG_FORMAT])?;
    Ok(parse_log_records(&out))
}

/// 校验版本号参数：只接受十六进制 hash（短 hash 也是），且不以 `-` 开头。
///
/// 参数走 argv 数组不会被 shell 解释，但 `-` 开头会被 git 当选项；限定为 hex 顺带挡掉
/// 一切「看起来像选项」的输入。渲染端传的是 `git_log` 回的 hash，本就是 hex。
fn validate_rev(rev: &str) -> Result<(), String> {
    if rev.is_empty() || rev.starts_with('-') {
        return Err(format!("非法版本号: {rev}"));
    }
    if !rev.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("非法版本号: {rev}"));
    }
    Ok(())
}

/// 单次提交引入的改动（统一 diff 文本）；`path` 限定时只看该路径。
///
/// `--format=` 压掉 git 自带的提交头（作者 / 日期 / 消息）：元信息由 `log_history` 提供，
/// 这里只要 diff 正文 —— 否则渲染端还得再切一次，而切点又受 locale / git 版本影响。
fn show_commit(
    access: &WorkspaceFsAccess,
    root: &str,
    hash: &str,
    path: Option<&str>,
) -> Result<String, String> {
    let root = resolve_root(access, root)?;
    validate_rev(hash)?;
    let mut args: Vec<&str> = vec!["show", "--format=", "--patch", hash];
    if let Some(path) = path {
        validate_rel_path(path)?;
        args.push("--");
        args.push(path);
    }
    run_git(&root, &args)
}

/* ===== Tauri 命令 ===== */

#[tauri::command]
pub fn git_status(
    access: tauri::State<'_, WorkspaceFsAccess>,
    root: String,
) -> Result<Vec<GitStatusDto>, String> {
    status(&access, &root)
}

#[tauri::command]
pub fn git_changes(
    access: tauri::State<'_, WorkspaceFsAccess>,
    root: String,
) -> Result<Vec<GitChangeDto>, String> {
    changes(&access, &root)
}

/// `staged` 缺省视为 false（看未暂存侧）：旧前端只传 root/path 时不会因为少一个字段而整条命令失败。
#[tauri::command]
pub fn git_diff(
    access: tauri::State<'_, WorkspaceFsAccess>,
    root: String,
    path: Option<String>,
    staged: Option<bool>,
) -> Result<String, String> {
    diff(&access, &root, path.as_deref(), staged.unwrap_or(false))
}

/// 暂存指定路径；`all` 为真时暂存全部。
#[tauri::command]
pub fn git_stage(
    access: tauri::State<'_, WorkspaceFsAccess>,
    root: String,
    paths: Vec<String>,
    all: bool,
) -> Result<(), String> {
    stage(&access, &root, &paths, all)
}

/// 取消暂存指定路径；`all` 为真时取消全部。
#[tauri::command]
pub fn git_unstage(
    access: tauri::State<'_, WorkspaceFsAccess>,
    root: String,
    paths: Vec<String>,
    all: bool,
) -> Result<(), String> {
    unstage(&access, &root, &paths, all)
}

/// 提交；`all` 为真时先 `add -A`（旧的「提交全部」），否则只提交已暂存的内容。
#[tauri::command]
pub fn git_commit(
    access: tauri::State<'_, WorkspaceFsAccess>,
    root: String,
    message: String,
    all: Option<bool>,
) -> Result<CommitResultDto, String> {
    commit(&access, &root, &message, all.unwrap_or(false))
}

#[tauri::command]
pub fn git_current_branch(
    access: tauri::State<'_, WorkspaceFsAccess>,
    root: String,
) -> Result<String, String> {
    current_branch(&access, &root)
}

#[tauri::command]
pub fn git_branch_list(
    access: tauri::State<'_, WorkspaceFsAccess>,
    root: String,
) -> Result<Vec<String>, String> {
    branch_list(&access, &root)
}

/// 提交历史；`limit` 缺省 50、`skip` 缺省 0（分页）。
#[tauri::command]
pub fn git_log(
    access: tauri::State<'_, WorkspaceFsAccess>,
    root: String,
    limit: Option<u32>,
    skip: Option<u32>,
) -> Result<Vec<GitCommitDto>, String> {
    log_history(&access, &root, limit, skip)
}

/// 单次提交的 diff；`path` 缺省为整次提交。
#[tauri::command]
pub fn git_show(
    access: tauri::State<'_, WorkspaceFsAccess>,
    root: String,
    hash: String,
    path: Option<String>,
) -> Result<String, String> {
    show_commit(&access, &root, &hash, path.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

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
        let a = result.iter().find(|e| e.path == "a.txt").expect("a 在变更里");
        assert_eq!(a.index.as_deref(), Some("modified"), "已跟踪文件改动后暂存 → M");
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
        assert!(!work.contains("b.txt"), "已暂存的文件不该出现在未暂存 diff 里");

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
        let page =
            log_history(&access, &root.to_string_lossy(), Some(1), Some(1)).expect("log 分页");
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
}
