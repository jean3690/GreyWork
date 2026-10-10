//! worktree 的对外 DTO 与 provision 标记的读写。

use serde::{Deserialize, Serialize};
use std::path::Path;

/// provision 标记文件名（写在每个快照目录根）。
const MARKER_FILE: &str = ".greywork-worktree.json";

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
pub(super) struct WorktreeMarker {
    pub(super) kind: String,
    pub(super) source: String,
}

/// 快照目录是否已写过 provision 标记。
pub(super) fn has_marker(target: &Path) -> bool {
    target.join(MARKER_FILE).is_file()
}

/// 写 provision 标记（kind + 源路径），供 release 正确回收。
pub(super) fn write_marker(target: &Path, marker: &WorktreeMarker) -> Result<(), String> {
    let bytes = serde_json::to_vec(marker).map_err(|error| format!("序列化标记失败: {error}"))?;
    std::fs::write(target.join(MARKER_FILE), bytes).map_err(|error| format!("写标记失败: {error}"))
}

pub(super) fn read_marker(target: &Path) -> Option<WorktreeMarker> {
    let bytes = std::fs::read(target.join(MARKER_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}
