//! 技能市场的桌面命令入口；实现收在 `greywork_host::skills_market`。

use greywork_host::skills_market::{
    InstallReport, MarketSkillEntry, SkillSnapshot, SkillSnapshotFile,
};

/// 搜索技能市场。
#[tauri::command]
pub async fn skills_search(
    origin: Option<String>,
    query: String,
) -> Result<Vec<MarketSkillEntry>, String> {
    greywork_host::skills_market::skills_search(origin, query).await
}

/// 下载一份技能快照（文件清单 + 内容），供前端预览后再安装。
#[tauri::command]
pub async fn skills_download(
    origin: Option<String>,
    entry_ref: String,
) -> Result<SkillSnapshot, String> {
    greywork_host::skills_market::skills_download(origin, entry_ref).await
}

/// 把一份技能快照落到工作区的 `.agents/skills/<id>` 下。
#[tauri::command]
pub async fn skills_install(
    workspace_root: String,
    skill_id: String,
    files: Vec<SkillSnapshotFile>,
) -> Result<InstallReport, String> {
    greywork_host::skills_market::skills_install(workspace_root, skill_id, files).await
}

/// 卸载工作区里已安装的技能。
#[tauri::command]
pub async fn skills_uninstall(workspace_root: String, skill_id: String) -> Result<(), String> {
    greywork_host::skills_market::skills_uninstall(workspace_root, skill_id).await
}
