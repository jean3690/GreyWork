//! 权限档位与决策纯逻辑：档位解析、工具分类、路径锚定、cwd 校验、决策。

use std::path::{Component, Path, PathBuf};

use agent_client_protocol::schema::v1::{
    PermissionOption, PermissionOptionId, PermissionOptionKind, RequestPermissionRequest,
    ToolCallLocation, ToolKind,
};

/// 权限档位（与前端 settings store 的 PermTier 一一对应）。
///
/// 语义（用户确认的新三档）：
/// - ReadOnly：禁止一切写/执行类工具（Edit/Delete/Move/Execute…），只读类自动放行；
/// - Workspace：写类工具仅限当前工作区内（越界直接拦截）；只读类自动放行；
///   界内写自动放行，Execute（命令目标不可静态提取）仍逐条转发前端；
/// - Full：不设工作区锚定，任何工具自动放行（选择前前端须弹警告确认）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum PermissionTier {
    /// 未知 / 缺失值 fail-closed。
    #[default]
    ReadOnly,
    Workspace,
    Full,
}

impl PermissionTier {
    /// 旧值（cautious/daily/auto）映射：daily→Workspace、auto→Full、其余→ReadOnly。
    pub(super) fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some("workspace") => PermissionTier::Workspace,
            Some("full") | Some("full-access") | Some("auto") => PermissionTier::Full,
            Some("read-only") | Some("readonly") | Some("read") => PermissionTier::ReadOnly,
            // 旧存档兼容
            Some("daily") => PermissionTier::Workspace,
            _ => PermissionTier::ReadOnly,
        }
    }
}

/// daily 档可自动放行的工具类别（只读语义）。
pub(super) fn is_readonly_kind(kind: Option<ToolKind>) -> bool {
    matches!(
        kind,
        Some(ToolKind::Read)
            | Some(ToolKind::Search)
            | Some(ToolKind::Fetch)
            | Some(ToolKind::Think)
    )
}

/// 写类工具：文件系统锚定只拦截会改动/删除文件的工具。
/// execute 不在此列：命令目标无法可靠静态提取，daily 档已转发前端确认。
pub(super) fn is_write_kind(kind: Option<ToolKind>) -> bool {
    matches!(
        kind,
        Some(ToolKind::Edit) | Some(ToolKind::Delete) | Some(ToolKind::Move)
    )
}

/// 词法规范化路径（解析 `.` / `..`），不触碰文件系统。
/// 仅用于锚定比较，文件可能尚不存在（新建场景）。
pub(super) fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 锚定比较用的归一化路径。
///
/// Windows 上 `canonicalize` 会给路径加 `\\?\`（verbatim）前缀，而 agent 在工具调用里
/// 报的路径没有；大小写与分隔符也不保证与锚定基准一致。不抹平这些差异，`starts_with`
/// 会把工作区内的写入误判成越界 —— 现象是「工作区档位下 agent 改不了自己目录里的文件」。
///
/// macOS 默认文件系统（APFS / HFS+）同样大小写不敏感，也一并折：agent 回一个大小写
/// 不同的路径会被 `is_within` 误拒（fail-closed，不是安全洞，但是 macOS 上的假阴性）。
/// 平台规则与阈值都收在 `path_safety::comparable_text`，这里只补一层词法归一。
pub(super) fn comparable_path(path: &Path) -> PathBuf {
    let normalized = normalize_lexical(path);
    PathBuf::from(crate::path_safety::comparable_text(
        &normalized.to_string_lossy(),
    ))
}

/// candidate 是否位于 base 目录树内（组件级前缀匹配，杜绝 `proj` vs `proj2` 误判）。
pub(super) fn is_within(base: &Path, candidate: &Path) -> bool {
    comparable_path(candidate).starts_with(comparable_path(base))
}

/// 写类工具中越出 workspace 锚定的路径清单（空 = 全部合法）。
pub(super) fn blocked_paths(root: &Path, locations: &[ToolCallLocation]) -> Vec<PathBuf> {
    locations
        .iter()
        .map(|location| &location.path)
        .filter(|path| !is_within(root, path))
        .cloned()
        .collect()
}

fn allow_option(options: &[PermissionOption]) -> Option<&PermissionOption> {
    options.iter().find(|option| {
        matches!(
            option.kind,
            PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways
        )
    })
}

pub(super) fn kind_label(kind: Option<ToolKind>) -> &'static str {
    match kind {
        Some(ToolKind::Read) => "read",
        Some(ToolKind::Edit) => "edit",
        Some(ToolKind::Delete) => "delete",
        Some(ToolKind::Move) => "move",
        Some(ToolKind::Search) => "search",
        Some(ToolKind::Execute) => "execute",
        Some(ToolKind::Think) => "think",
        Some(ToolKind::Fetch) => "fetch",
        Some(ToolKind::SwitchMode) => "switch_mode",
        _ => "other",
    }
}

pub(super) fn option_kind_label(kind: PermissionOptionKind) -> &'static str {
    match kind {
        PermissionOptionKind::AllowOnce => "allow_once",
        PermissionOptionKind::AllowAlways => "allow_always",
        PermissionOptionKind::RejectOnce => "reject_once",
        PermissionOptionKind::RejectAlways => "reject_always",
        _ => "other",
    }
}

/// cwd 校验：绝对路径、已存在的目录、非文件系统根（"/"、"C:\"、"\\server\share"）。
pub(super) fn validate_cwd(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    let path = PathBuf::from(trimmed);
    if trimmed.is_empty() || !path.is_absolute() {
        return Err(format!("cwd must be an absolute path, got: {raw:?}"));
    }
    if crate::path_safety::is_filesystem_root(&path) {
        return Err("cwd must not be a filesystem root".to_string());
    }
    if !path.is_dir() {
        return Err(format!(
            "cwd does not exist or is not a directory: {}",
            path.display()
        ));
    }
    Ok(path)
}

/// 一条权限请求的宿主决策上下文快照：锁内取出、锁外使用，避免跨 await 持锁。
pub(super) struct SessionPolicy {
    pub(super) tier: PermissionTier,
    pub(super) workspace_root: Option<PathBuf>,
}

impl Default for SessionPolicy {
    /// handle 未登记时的兜底：最严档位 + 无锚定基准。
    /// tier=ReadOnly 兜底（fail-closed）：即使拿不到工作区根也没有写放行路径。
    fn default() -> Self {
        Self {
            tier: PermissionTier::ReadOnly,
            workspace_root: None,
        }
    }
}

/// 宿主对一条权限请求的裁决（纯函数产物，不含 I/O），由 `decide_permission` 得出。
#[derive(Debug, PartialEq, Eq)]
pub(super) enum PermissionVerdict {
    /// 只读档：写/执行类工具一律拒绝（不依赖锚定）。
    BlockedReadOnly,
    /// Workspace 档：写类工具路径越出工作区：直接拒绝，附越界路径清单。
    BlockedOutsideWorkspace(Vec<PathBuf>),
    /// 按档位自动放行，附选中的 Allow 选项。
    AutoAllow(PermissionOptionId),
    /// Full 档但请求未提供任何 Allow 选项：直接取消，不打扰用户。
    AutoCancel,
    /// 转发前端逐条确认。
    Ask,
}

/// 档位 + 工作区锚定的完整决策逻辑。抽成纯函数以便直接单测宿主策略，
/// 而不必拉起 Tauri app / agent 进程。
///
/// 判定顺序：档位边界（只读/锚定）> 档位自动放行 > 转发前端。
/// Full 档跳过锚定（选择前已由前端警告确认）；Workspace 档的锚定不可绕过。
pub(super) fn decide_permission(
    policy: &SessionPolicy,
    request: &RequestPermissionRequest,
) -> PermissionVerdict {
    let kind = request.tool_call.fields.kind;
    let readonly = is_readonly_kind(kind);
    let write = is_write_kind(kind);

    match policy.tier {
        PermissionTier::ReadOnly => {
            // 非只读类（写 / 执行 / 未知）一律拒绝；只读类放行（无 Allow 选项则问前端）
            if !readonly {
                return PermissionVerdict::BlockedReadOnly;
            }
            if let Some(option) = allow_option(&request.options) {
                return PermissionVerdict::AutoAllow(option.option_id.clone());
            }
            PermissionVerdict::Ask
        }
        PermissionTier::Workspace => {
            if write {
                match policy.workspace_root.as_deref() {
                    // 无锚定基准（未绑工作区/未建会话）→ 写类逐条确认，不盲放
                    None => return PermissionVerdict::Ask,
                    Some(root) => {
                        let locations = request
                            .tool_call
                            .fields
                            .locations
                            .as_deref()
                            .unwrap_or_default();
                        let outside = blocked_paths(root, locations);
                        if !outside.is_empty() {
                            return PermissionVerdict::BlockedOutsideWorkspace(outside);
                        }
                        // 界内写：自动放行（工作区语义 = 区内自由读写）
                        if let Some(option) = allow_option(&request.options) {
                            return PermissionVerdict::AutoAllow(option.option_id.clone());
                        }
                        return PermissionVerdict::Ask;
                    }
                }
            }
            // 只读类自动放行；Execute 等无法验证目标的工具逐条确认
            if readonly {
                if let Some(option) = allow_option(&request.options) {
                    return PermissionVerdict::AutoAllow(option.option_id.clone());
                }
            }
            PermissionVerdict::Ask
        }
        PermissionTier::Full => {
            if let Some(option) = allow_option(&request.options) {
                PermissionVerdict::AutoAllow(option.option_id.clone())
            } else {
                PermissionVerdict::AutoCancel
            }
        }
    }
}
