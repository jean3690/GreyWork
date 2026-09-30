//! 内置技能的桌面命令入口；实现收在 `greywork_host::bundled_skills`。

use greywork_host::bundled_skills::BundledSkillMeta;
use greywork_host::skills_market::InstallReport;

/// 列出随包内置的技能（内容已编译进二进制，不联网）。
#[tauri::command]
pub fn skills_bundled_list() -> Vec<BundledSkillMeta> {
    greywork_host::bundled_skills::skills_bundled_list()
}

/// 把一份内置技能安装到工作区 `.agents/skills/<id>/`。
#[tauri::command]
pub fn skills_install_bundled(
    workspace_root: String,
    skill_id: String,
) -> Result<InstallReport, String> {
    greywork_host::bundled_skills::skills_install_bundled(workspace_root, skill_id)
}
