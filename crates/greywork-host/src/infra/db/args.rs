//! 数据库命令的入参结构（dispatch 用；与前端扁平入参 camelCase 对齐）。
//!
//! 逻辑一律走 [`Db`] 的同名方法，本模块只声明形状 —— 之前的 `db_*` 纯转发函数已删除。

use super::dto::*;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSyncArgs {
    pub settings: serde_json::Value,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationsSyncArgs {
    pub tasks: Vec<AutomationTaskDto>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DueFinishArgs {
    pub id: i64,
    pub status: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunsLoadArgs {
    pub limit: Option<i64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecordArgs {
    pub run: AutomationRunInputDto,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunsSyncArgs {
    pub runs: Vec<TeamRunDto>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsSyncArgs {
    pub providers: Vec<AgentProviderDto>,
}
