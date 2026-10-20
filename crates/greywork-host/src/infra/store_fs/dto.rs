//! 对外 DTO。

use serde::{Deserialize, Serialize};

/// 前端工作区目录清单（会话归属 → 磁盘文件夹）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirDto {
    pub id: String,
    /// 用户选择的文件夹（绝对路径；None/空 = 未绑定 → 默认目录）。
    pub folder: Option<String>,
}

/// 一条被拒绝覆盖的会话：磁盘版本比内存版本新（另一实例写过）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDto {
    pub id: String,
    pub disk_updated_at: i64,
}

/// 增量同步结果：前端据此判断是否需要回读合并。
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncReportDto {
    pub written: usize,
    pub skipped: usize,
    pub deleted: usize,
    pub conflicts: Vec<ConflictDto>,
}

/// 会话搬迁请求：工作区改绑文件夹时把既有会话文件挪到新目录。
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RelocateRequestDto {
    pub session_ids: Vec<String>,
    /// 原文件夹（None = 默认根 `~/.greyWork`）。
    pub from_folder: Option<String>,
    /// 目标文件夹（None = 默认根）。
    pub to_folder: Option<String>,
}

/// 搬迁结果：moved 实际搬走的条数，missing 源侧本就没有文件的 id，
/// conflicts 目标侧已有更新版本、两边都保留的 id。
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelocateReportDto {
    pub moved: usize,
    pub missing: Vec<String>,
    pub conflicts: Vec<String>,
}
