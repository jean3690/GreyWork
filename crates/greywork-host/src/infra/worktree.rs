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

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

use crate::core::ports::WorkspaceFs;
use crate::host::HostContext;
use crate::store_fs;
#[cfg(test)]
use crate::workspace_fs::WorkspaceFsAccess;

const GIT: &str = "git";
const WORKTREES_SUB_DIR: &str = "worktrees";
const MARKER_FILE: &str = ".greywork-worktree.json";
/// 项目约定的 `.agents/` 目录（与 `.agents/skills/` 同源）。
const AGENTS_DIR: &str = ".agents";
/// 共享文件清单：列出的路径会被符号链接进每个新快照。
const LINKED_FILE: &str = "linked";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeProvisionDto {
    pub root: String,
    /// git：真实 worktree / copy：目录复制兜底 / direct：数据根直通（无隔离）。
    pub kind: String,
    pub source: String,
}

/// 列表项：一个已派生的隔离快照（设置页「运行模式」的回收面板消费）。
///
/// `direct` 不会出现在列表里 —— provision 判定「源就是数据根」时直接原样返回、
/// 不落任何快照，因此没有可供列出与回收的目录。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntryDto {
    pub root: String,
    /// git：真实 worktree / copy：目录复制兜底。
    pub kind: String,
    pub source: String,
    /// 快照目录占用字节。git 快照只含检出文件：对象库与源仓库共享，故不含仓库历史。
    pub bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeMarker {
    kind: String,
    source: String,
}

/* ===== 底层执行 ===== */

/// 在指定目录里执行 git；失败返回 stderr（去尾空白）。绝不弹出交互提示。
fn run_git(root: &Path, args: &[&str]) -> Result<String, String> {
    run_git_env(root, args, &[])
}

/// 与 `run_git` 同形，但可追加环境变量。回合快照用它把 `GIT_INDEX_FILE` 指到临时索引，
/// 从而在不碰真实 index 的前提下构建整棵工作树的 tree。
fn run_git_env(root: &Path, args: &[&str], envs: &[(&str, &str)]) -> Result<String, String> {
    let mut cmd = std::process::Command::new(GIT);
    crate::process_guard::hide_console_std(&mut cmd);
    cmd.current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["-c", "core.quotepath=false"]);
    for (key, value) in envs {
        cmd.env(key, value);
    }
    cmd.args(args);
    let output = cmd
        .output()
        .map_err(|error| format!("无法启动 git: {error}"))?;
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

/// 源目录是否在某个 git 仓库里（.git 文件或目录都算）。
fn is_git_repo(source: &Path) -> bool {
    source.join(".git").is_file() || source.join(".git").is_dir()
}

/// 净名slug：取源目录文件名的安全形态（只留字母数字 `_` `-`），空则回落 `ws`。
fn slug(source: &Path) -> String {
    let raw = source
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default();
    let cleaned: String = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "ws".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 源路径指纹：`sha256(可比路径)[:12]`。目录名与分支名共用同一份指纹，
/// 保证「同一个源 → 同一个快照目录、同一个分支」。
fn source_fingerprint(source: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(crate::path_safety::comparable_text(&source.to_string_lossy()).as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    digest[..12].to_string()
}

/// 确定性目标目录：`<base>/<slug>-<指纹>`。
fn deterministic_target(base: &Path, source: &Path) -> Result<PathBuf, String> {
    Ok(base.join(format!("{}-{}", slug(source), source_fingerprint(source))))
}

/// 快照工作树所在的分支名：`greywork/<slug>-<指纹>`，与快照目录同名。
///
/// worktree 与源仓库**共享 `refs/heads/*`**，所以这个分支天然就落在用户仓库里——
/// 无需任何 remote 即可把 agent 的提交交回（`git branch` / `git log` 直接可见）。
/// 命名确定性也让「release 后再 provision」能复用到同一分支（见 `add_worktree_branch`）。
fn worktree_branch(source: &Path) -> String {
    format!("greywork/{}-{}", slug(source), source_fingerprint(source))
}

/// 在快照目录建工作树，落在 `branch` 上。
///
/// 先尝试用 `-b` **新建**分支；若分支已存在（多半是上一次 release 留下的），
/// 退回「挂到已存在分支」以**复用**它、保留分支上已有的提交。
/// 两条路径都失败（例如分支正被另一个 worktree 检出）才交给调用方回落复制。
///
/// **绝不使用 `-B`**：`-B` 会把已存在分支重置到源当前 HEAD，静默丢弃用户
/// 可能已合并或待处理的提交。
fn add_worktree_branch(source: &Path, branch: &str, target: &str) -> Result<(), String> {
    match run_git(source, &["worktree", "add", "-b", branch, target]) {
        Ok(_) => Ok(()),
        Err(create_error) => run_git(source, &["worktree", "add", target, branch])
            .map(|_| ())
            .map_err(|attach_error| {
                format!("worktree add 失败（新建: {create_error}；复用: {attach_error}）")
            }),
    }
}

/// 递归复制目录快照：跳过 `.git`、`.greyWork`（应用私有数据）与**符号链接**
/// （不追随链接，避免复制时逃出源树）。
fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|error| format!("创建快照目录失败: {error}"))?;
    for entry in std::fs::read_dir(src).map_err(|error| format!("读取源目录失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取目录项失败: {error}"))?;
        let name = entry.file_name();
        if name == ".git" || name == store_fs::GREY_WORK_DIR {
            continue;
        }
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("读取目录项元数据失败: {error}"))?;
        if metadata.is_symlink() {
            continue;
        }
        let target = dst.join(&name);
        if metadata.is_dir() {
            copy_dir(&path, &target)?;
        } else if metadata.is_file() {
            std::fs::copy(&path, &target).map_err(|error| format!("复制文件失败: {error}"))?;
        }
    }
    Ok(())
}

/// 递归累加目录占用字节。与 `copy_dir` 同一条纪律：**不追随符号链接**，
/// 免得顺着链接走出快照、或踩进自引用成环。读不到的条目按 0 计 —— 体积是展示项，
/// 不因为它报错就整个列表失败。
fn dir_bytes(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let path = entry.path();
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_dir() => dir_bytes(&path),
                Ok(metadata) if metadata.is_file() => metadata.len(),
                _ => 0,
            }
        })
        .sum()
}

/// 写 provision 标记（kind + 源路径），供 release 正确回收。
fn write_marker(target: &Path, marker: &WorktreeMarker) -> Result<(), String> {
    let bytes = serde_json::to_vec(marker).map_err(|error| format!("序列化标记失败: {error}"))?;
    std::fs::write(target.join(MARKER_FILE), bytes).map_err(|error| format!("写标记失败: {error}"))
}

fn read_marker(target: &Path) -> Option<WorktreeMarker> {
    let bytes = std::fs::read(target.join(MARKER_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/* ===== .agents/linked：共享文件的符号链接 ===== */

/// 逐行读 `.agents/linked`：去空白、跳过空行与 `#` 注释。
///
/// 从**源**读而不是从快照读：清单若尚未提交，git worktree 里根本没有这个文件。
fn read_linked_entries(source: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(source.join(AGENTS_DIR).join(LINKED_FILE)) else {
        return Vec::new();
    };
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect()
}

/// 条目是否是安全的**相对**路径：不含 `..`、绝对路径前缀或根目录。
///
/// 这是防逃逸的第一道闸：`../../etc` 这类条目会让符号链接指到源树之外。
/// 用 `Component` 而不是字符串前缀判断 —— Windows 的 `C:\` 前缀与 `/` 根目录都要拦。
fn is_safe_relative(entry: &str) -> bool {
    use std::path::Component;
    let path = Path::new(entry);
    if path.is_absolute() {
        return false;
    }
    !path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        )
    })
}

/// 创建符号链接：Unix 一条路径；Windows 按源是目录还是文件分流。
#[cfg(unix)]
fn create_symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst)
}

#[cfg(windows)]
fn create_symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::os::windows::fs::symlink_dir(src, dst)
    } else {
        std::os::windows::fs::symlink_file(src, dst)
    }
}

/// 按 `.agents/linked` 把源仓库里的共享文件以符号链接挂进新快照。
///
/// 契约（与 Delta 一致，也是正确性的前提）：
/// - 条目必须是安全相对路径（见 `is_safe_relative`）；
/// - 条目必须被 git 忽略 —— 否则链接会以「新增文件」出现在 git status / 变更视图里；
/// - 只链接源里**已存在**的文件/目录，绝不创建源文件。
///
/// 任一条不满足就跳过并告警，**绝不让 provision 整体失败**：快照本身是可用的，
/// 一个配置失误的清单不该让整个隔离环境起不来。Windows 上创建符号链接需要开发者模式或
/// 管理员权限，失败时同样只告警（功能降级，不是错误）。
fn apply_linked(source: &Path, target: &Path) {
    for entry in read_linked_entries(source) {
        if !is_safe_relative(&entry) {
            crate::log::warn(
                "worktree",
                format!(".agents/linked 条目不是安全的相对路径，已跳过: {entry}"),
            );
            continue;
        }
        // 必须被 git 忽略：链接出现在 git status 里会污染 agent 的变更视图。
        if run_git(source, &["check-ignore", "-q", "--", entry.as_str()]).is_err() {
            crate::log::warn(
                "worktree",
                format!(".agents/linked 条目未被 git 忽略，已跳过: {entry}"),
            );
            continue;
        }
        let src = source.join(&entry);
        if !src.exists() {
            crate::log::warn(
                "worktree",
                format!(".agents/linked 条目在源中不存在，已跳过: {entry}"),
            );
            continue;
        }
        let dst = target.join(&entry);
        if dst.exists() {
            continue; // 快照里已有同名项（被忽略就不该有），不覆盖
        }
        if let Some(parent) = dst.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                crate::log::warn(
                    "worktree",
                    format!(".agents/linked 创建父目录失败 {entry}: {error}"),
                );
                continue;
            }
        }
        if let Err(error) = create_symlink(&src, &dst) {
            crate::log::warn(
                "worktree",
                format!(".agents/linked 创建符号链接失败 {entry}: {error}"),
            );
        }
    }
}

/* ===== .agents/prepare：新快照的准备脚本 ===== */

/// prepare 脚本的超时上限。Delta 明确要求它「必须快」（每次 provision 都跑），
/// 给一个不拖住隔离环境的硬上限。
const PREPARE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// 组装执行 `.agents/prepare` 的命令：
/// - Unix：文件可执行就直接跑（尊重 shebang），否则交给 `sh`；
/// - Windows：统一走 `cmd /C`（`.cmd`/`.bat` 与无扩展名脚本都能起）。
fn prepare_command(script: &Path) -> std::process::Command {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let executable = std::fs::metadata(script)
            .map(|meta| meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
        if executable {
            std::process::Command::new(script)
        } else {
            let mut cmd = std::process::Command::new("sh");
            cmd.arg(script);
            cmd
        }
    }
    #[cfg(not(unix))]
    {
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/C").arg(script);
        cmd
    }
}

/// 运行 `<checkout>/.agents/prepare`（若存在）。
///
/// 语义与 Delta 一致：脚本负责把新快照配置到可用状态（构建缓存、git 钩子、配置文件）。
/// 失败 / 超时**只告警不失败** —— 快照本身可用，一个坏脚本不该让隔离环境起不来。
///
/// 只在**快照新建时**跑（幂等复用的早返回分支不会到这儿）：脚本的职责是「配置这份
/// checkout」，不是「每个会话跑一次」。
fn run_prepare(target: &Path) {
    let script = target.join(AGENTS_DIR).join("prepare");
    if !script.is_file() {
        return;
    }
    let mut cmd = prepare_command(&script);
    crate::process_guard::hide_console_std(&mut cmd);
    cmd.current_dir(target)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null());
    match crate::git::run_capture(&mut cmd, PREPARE_TIMEOUT) {
        Ok(output) if output.status.success() => {}
        Ok(output) => crate::log::warn(
            "worktree",
            format!(
                ".agents/prepare 退出码非零: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ),
        Err(error) => crate::log::warn("worktree", format!(".agents/prepare 执行失败: {error}")),
    }
}

fn strip(raw: &Path) -> String {
    crate::path_safety::strip_verbatim_prefix(&raw.to_string_lossy())
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

/* ===== 核心逻辑（home 由命令/测试各自提供） ===== */

fn provision(
    access: &dyn WorkspaceFs,
    home: &Path,
    source_raw: &str,
    prepare: bool,
) -> Result<WorktreeProvisionDto, String> {
    let source = access.resolve_existing(source_raw)?;
    if !source.is_dir() {
        return Err("worktree 源必须是目录".into());
    }
    let home = canonical_home(home);
    let default_root = store_fs::default_root(&home)?;
    let worktrees_base = default_root.join(WORKTREES_SUB_DIR);
    // 数据根本身没有可隔离的工作区：直通，不做任何复制/目录创建。
    if crate::path_safety::same_path(&source, &default_root) {
        return Ok(WorktreeProvisionDto {
            root: strip(&source),
            kind: "direct".to_string(),
            source: strip(&source),
        });
    }

    let target = deterministic_target(&worktrees_base, &source)?;
    // 快照目录绝不能落在源目录内部：源恰好是数据根时（`~/.greyWork` 内有 `worktrees/`），
    // `copy_dir` 会顺着刚建出来的目标目录一路递归到爆栈。这条不变量挡在复制之前。
    if target.starts_with(&source) {
        return Err(format!(
            "快照目录会落在源目录内部，无法隔离: {}",
            target.display()
        ));
    }
    let stripped = strip(&source);

    // 幂等：已 provision 过就直接复用（目录名对同一 source 确定）。
    if target.join(MARKER_FILE).is_file() {
        let kind = read_marker(&target)
            .map(|marker| marker.kind)
            .unwrap_or_else(|| "copy".to_string());
        return Ok(WorktreeProvisionDto {
            root: strip(&target),
            kind,
            source: stripped,
        });
    }
    if target.exists() {
        // 目录存在但没标记：多半是废快照。不自动删除（避免误删用户数据），提示先 release。
        return Err(format!(
            "快照目录已存在但没有 provision 标记，请先 worktree_release 再重试: {}",
            target.display()
        ));
    }

    std::fs::create_dir_all(&worktrees_base)
        .map_err(|error| format!("创建 worktrees 基目录失败: {error}"))?;

    // git 仓库走真实 worktree；空仓库 / add 失败一律回落复制兜底（kind="copy"）。
    // 交给 git 的路径要先 strip：Windows 上 `canonicalize` 带来的 `\\?\` 前缀 git 不认，
    // 会让 `worktree add` 失败、静默回落成 copy（snapshot 仍是快照，但不是真 worktree）。
    let target_plain = strip(&target);
    let kind = if is_git_repo(&source) {
        // 在命名分支上检出（而非 `--detach`）：分支进源仓库共享 refs，agent 的提交在
        // release 之后仍可达、可 merge。`--detach` 的提交会随 worktree 一起被丢弃。
        let branch = worktree_branch(&source);
        match add_worktree_branch(Path::new(&stripped), &branch, target_plain.as_str()) {
            Ok(()) => "git",
            Err(error) => {
                crate::log::warn(
                    "worktree",
                    format!("git worktree add 失败（回落复制兜底）: {error}"),
                );
                copy_dir(&source, &target)?;
                "copy"
            }
        }
    } else {
        copy_dir(&source, &target)?;
        "copy"
    };
    // `.agents/linked`：把源里被 git 忽略的共享文件以符号链接挂进新快照。
    // 只在源是 git 仓库时有意义（清单本身依赖 git 忽略判定），非 git 源直接跳过。
    if is_git_repo(&source) {
        apply_linked(&source, &target);
    }
    // `.agents/prepare`：由调用方按权限档决定是否执行（只读档不跑）。先 linked 后 prepare，
    // 好让脚本能用到刚挂进来的共享文件（如 .env）。
    if prepare {
        run_prepare(&target);
    }
    write_marker(
        &target,
        &WorktreeMarker {
            kind: kind.to_string(),
            source: source.to_string_lossy().into_owned(),
        },
    )?;
    Ok(WorktreeProvisionDto {
        root: strip(&target),
        kind: kind.to_string(),
        source: stripped,
    })
}

fn release(access: &dyn WorkspaceFs, home: &Path, root_raw: &str) -> Result<(), String> {
    let root = access.resolve_existing(root_raw)?;
    let home = canonical_home(home);
    let default_root = store_fs::default_root(&home)?;
    let worktrees_base = default_root.join(WORKTREES_SUB_DIR);
    // 只允许回收基目录之下的快照，绝不删除数据根 / 用户目录本身。
    if !root.starts_with(&worktrees_base) {
        return Err("只允许释放 ~/.greyWork/worktrees 下的隔离快照".into());
    }
    if !root.exists() {
        return Ok(()); // 幂等：已回收视为成功
    }
    let kind = read_marker(&root)
        .map(|marker| marker.kind)
        .unwrap_or_else(|| "copy".to_string());
    if kind == "git" {
        let marker = read_marker(&root);
        let removed_via_git = marker
            .as_ref()
            .map(|marker| {
                // 与 provision 同一条纪律：交给 git 的路径先 strip 掉 `\\?\`。
                let source_plain = strip(Path::new(&marker.source));
                let source = Path::new(&source_plain);
                if source.is_dir() && is_git_repo(source) {
                    // 必须在仓库内（源）执行，git 不允许移除「当前工作树」。
                    let target_plain = strip(&root);
                    run_git(
                        source,
                        &[
                            "worktree",
                            "remove",
                            "--force",
                            "--force",
                            target_plain.as_str(),
                        ],
                    )
                    .is_ok()
                } else {
                    false
                }
            })
            .unwrap_or(false);
        if !removed_via_git {
            crate::log::warn(
                "worktree",
                format!(
                    "git worktree remove 失败或源缺失，退回整目录删除: {}",
                    root.display()
                ),
            );
        }
    }
    // git worktree remove 成功时目录**已经被它删掉**，这里只兜底其余情况（copy、
    // git 删除失败退回整目录删）。顺带守住与开头同一个不变量：目录已不在就是已回收，
    // 不因为「别人先删了」报错。
    if !root.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&root).map_err(|error| format!("删除快照目录失败: {error}"))
}

/* ===== 回合快照：会话 + 文件一起回退（A3a） ===== */

/// 回合快照的私有 ref 命名空间。刻意放在 `refs/greywork/` 而非 `refs/heads/`：既不进
/// `git branch`、不污染交回给用户的分支，又能随共享对象库留存（`git worktree remove`
/// 不会删 ref）。同名空间日后也可用于清理快照。
const SNAPSHOT_REF_PREFIX: &str = "refs/greywork/snap";

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
fn snapshot(access: &dyn WorkspaceFs, home: &Path, root_raw: &str) -> Result<String, String> {
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
fn restore(
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

/// 列出 `<数据根>/worktrees` 下的隔离快照。
///
/// 只认写过 provision 标记的目录：基目录里没有标记的东西（用户手放的、上次崩溃留下的
/// 半成品）不列 —— 列出来也只会给 UI 一个 `release` 会拒收的条目。
fn list(home: &Path) -> Result<Vec<WorktreeEntryDto>, String> {
    let home = canonical_home(home);
    let worktrees_base = store_fs::default_root(&home)?.join(WORKTREES_SUB_DIR);
    if !worktrees_base.is_dir() {
        return Ok(Vec::new()); // 一次都没派过：空列表，不是错误
    }
    let entries = std::fs::read_dir(&worktrees_base)
        .map_err(|error| format!("读取 worktrees 目录失败: {error}"))?;
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let target = entry.path();
        if !target.is_dir() {
            continue;
        }
        let Some(marker) = read_marker(&target) else {
            continue;
        };
        found.push(WorktreeEntryDto {
            // 与 provision 的返回值同形（都过 strip），前端才能把 root 原样回传给 release。
            root: strip(&target),
            kind: marker.kind,
            source: strip(Path::new(&marker.source)),
            bytes: dir_bytes(&target),
        });
    }
    // 目录名对同一源是确定的，排序只为让列表在 UI 里稳定不抖动。
    found.sort_by(|left, right| left.root.cmp(&right.root));
    Ok(found)
}

/* ===== 命令实现入口 ===== */

pub fn worktree_provision(
    host: &dyn HostContext,
    access: &dyn WorkspaceFs,
    source: String,
    prepare: bool,
) -> Result<WorktreeProvisionDto, String> {
    provision(access, &host.paths().home_dir, &source, prepare)
}

pub fn worktree_release(
    host: &dyn HostContext,
    access: &dyn WorkspaceFs,
    root: String,
) -> Result<(), String> {
    release(access, &host.paths().home_dir, &root)
}

/// 列出隔离快照。不取 WorkspaceFsAccess：入参只有 home，扫的是应用自己的
/// `~/.greyWork/worktrees`，没有任何用户可控路径参与，无需授权校验。
pub fn worktree_list(host: &dyn HostContext) -> Result<Vec<WorktreeEntryDto>, String> {
    list(&host.paths().home_dir)
}

/// 记一次工作区回合快照，返回其 ref 名（渲染层把它挂到对应消息上）。
pub fn worktree_snapshot(
    host: &dyn HostContext,
    access: &dyn WorkspaceFs,
    root: String,
) -> Result<String, String> {
    snapshot(access, &host.paths().home_dir, &root)
}

/// 把工作区硬回退到某个快照 ref（严格等于快照）。
pub fn worktree_restore(
    host: &dyn HostContext,
    access: &dyn WorkspaceFs,
    root: String,
    reference: String,
) -> Result<(), String> {
    restore(access, &host.paths().home_dir, &root, &reference)
}

/* ===== 命令入参 ===== */

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionArgs {
    pub source: String,
    /// 是否执行 `.agents/prepare`。默认 **false**（fail-closed）：服务端会按 `tier`
    /// 覆盖本字段，只读档一律夹成 false（见 `apps/server` 的 `overlay_args`）。
    #[serde(default)]
    pub prepare: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseArgs {
    pub root: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotArgs {
    pub root: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreArgs {
    pub root: String,
    /// `worktree_snapshot` 返回的 ref 名（`refs/greywork/snap/<id>`）。
    pub reference: String,
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
        let again =
            provision(&access, &home, &root.to_string_lossy(), false).expect("再次 provision");
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
        let again =
            provision(&access, &home, &repo.to_string_lossy(), false).expect("再次 provision");
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
        let again =
            provision(&access, &home, &repo.to_string_lossy(), false).expect("再 provision");
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
}
