//! 命令入口（薄壳）：逻辑在 Db 方法，便于脱离宿主单测。

use super::dto::*;
use super::Db;

/// 读设置快照（meta.settings）；从未持久化过 → null。
pub fn db_settings_load(db: &Db) -> Result<Option<serde_json::Value>, String> {
    db.load_settings()
}

/// 全量替换设置快照（单对象 upsert；调用方为渲染端显式 persist）。
pub fn db_settings_sync(db: &Db, settings: serde_json::Value) -> Result<(), String> {
    db.sync_settings(&settings)
}

/// 读自动化任务清单；库未接管 → null（前端以种子回填并首落库）。
pub fn db_automations_load(db: &Db) -> Result<Option<Vec<AutomationTaskDto>>, String> {
    db.load_automations()
}

/// 全量替换自动化清单（事务幂等）。
pub fn db_automations_sync(db: &Db, tasks: Vec<AutomationTaskDto>) -> Result<(), String> {
    db.sync_automations(&tasks)
}

/// 拉取到期执行队列（pending 且在最近窗口内；渲染端单消费循环调用）。
pub fn db_automations_due_list(db: &Db) -> Result<Vec<AutomationDueDto>, String> {
    db.automation_due_list()
}

/// 完成认领到期任务（pending → success/failed；原子防双执行）。
pub fn db_automations_due_finish(db: &Db, id: i64, status: String) -> Result<bool, String> {
    db.automation_due_finish(id, &status)
}

/// 读运行记录（新→旧，默认最近 200 条）。
pub fn db_automation_runs_load(
    db: &Db,
    limit: Option<i64>,
) -> Result<Vec<AutomationRunDto>, String> {
    db.automation_runs_load(limit.unwrap_or(200))
}

/// 记一条运行结果（库侧按 task 裁剪保留最近 50 条）。
pub fn db_automation_run_record(db: &Db, run: AutomationRunInputDto) -> Result<(), String> {
    db.automation_record_run(&run)
}

/// 读编排运行存档；库未接管 → null。
pub fn db_team_runs_load(db: &Db) -> Result<Option<Vec<TeamRunDto>>, String> {
    db.load_team_runs()
}

/// 全量替换编排存档（事务幂等；运行结束后由渲染端写一次）。
pub fn db_team_runs_sync(db: &Db, runs: Vec<TeamRunDto>) -> Result<(), String> {
    db.sync_team_runs(&runs)
}

/// 读 ACP 后端目录；库未接管 → null（前端以内置缺省 seed 并首落库）。
pub fn db_agents_load(db: &Db) -> Result<Option<Vec<AgentProviderDto>>, String> {
    db.load_agent_providers()
}

/// 全量替换 ACP 后端目录（事务幂等；启停切换由渲染端 persist 驱动）。
pub fn db_agents_sync(db: &Db, providers: Vec<AgentProviderDto>) -> Result<(), String> {
    db.sync_agent_providers(&providers)
}

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
