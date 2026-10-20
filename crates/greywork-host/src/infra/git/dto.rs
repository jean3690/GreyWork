//! 对外 DTO（camelCase 对齐前端 GitService 接口）。

use serde::Serialize;

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
