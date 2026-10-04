//! 随包内置技能：编译期用 `include_str!` 把技能内容嵌进二进制，安装时写到
//! 工作区 `.agents/skills/<id>/`。
//!
//! 与市场技能（`skills_market`）的区别只在**来源**：市场技能经网络下载快照，
//! 内置技能的内容已在二进制里，因此不需要联网、也不需要用户先配技能源。
//! 落盘走的是同一套净化写入（`skills_market::write_skill_snapshot`），
//! 所以「技能目录里能出现什么」只有一条实现。
//!
//! 适合放进来的：本应用自己就要驱动某类外部工具的场景（如 ffmpeg 视频处理），
//! 技能内容与宿主版本一起走，不会因为市场条目改名/下架而失效。

use serde::Serialize;

use crate::skills_market::{
    validate_skill_id, validate_workspace_root, write_skill_snapshot, InstallReport,
    SkillSnapshotFile,
};

/// 内置技能里的一个文件；`contents` 由 `include_str!` 在编译期填入。
struct BundledFile {
    path: &'static str,
    contents: &'static str,
}

/// 一份内置技能。
struct BundledSkill {
    /// 必须满足 `validate_skill_id` 的小写 slug 规则（安装路径由它构造）。
    id: &'static str,
    name: &'static str,
    description: &'static str,
    files: &'static [BundledFile],
}

/// 内置技能清单。
///
/// 加新技能只需在这里加一条 —— 命令表、桌面包装、前端目录都不用改：
/// `skills_bundled_list` 直接遍历本表。
const BUNDLED_SKILLS: &[BundledSkill] = &[BundledSkill {
    id: "ffmpeg-media",
    name: "ffmpeg 媒体处理",
    description:
        "用 ffmpeg / ffprobe 做转码、截取、拼接、抽帧、压缩、提取音轨；产物落在工作区可直接预览。",
    files: &[BundledFile {
        path: "SKILL.md",
        contents: include_str!("../../assets/bundled-skills/ffmpeg-media/SKILL.md"),
    }],
}];

/// `skills_bundled_list` 的返回项（前端「内置技能」区的目录）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledSkillMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    /// 该技能包含的文件相对路径（含 `SKILL.md`），供 UI 展示。
    pub files: Vec<String>,
}

/// 列出全部内置技能（纯静态，不需要工作区）。
pub fn skills_bundled_list() -> Vec<BundledSkillMeta> {
    BUNDLED_SKILLS
        .iter()
        .map(|skill| BundledSkillMeta {
            id: skill.id.to_string(),
            name: skill.name.to_string(),
            description: skill.description.to_string(),
            files: skill
                .files
                .iter()
                .map(|file| file.path.to_string())
                .collect(),
        })
        .collect()
}

/// 把某份内置技能写入 `<workspaceRoot>/.agents/skills/<id>/`（已存在即覆盖更新）。
pub fn skills_install_bundled(
    workspace_root: String,
    skill_id: String,
) -> Result<InstallReport, String> {
    let root = validate_workspace_root(&workspace_root)?;
    let id = validate_skill_id(&skill_id)?;
    let skill = BUNDLED_SKILLS
        .iter()
        .find(|skill| skill.id == id.as_str())
        .ok_or_else(|| format!("不是内置技能: {id}"))?;
    // 静态内容转成快照文件，复用市场的净化写入（文件数/单文件体积上限一并生效）。
    let files: Vec<SkillSnapshotFile> = skill
        .files
        .iter()
        .map(|file| SkillSnapshotFile {
            path: file.path.to_string(),
            contents: file.contents.to_string(),
        })
        .collect();
    write_skill_snapshot(&root, &id, &files)
}

/// `skills_install_bundled` 的入参。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallBundledArgs {
    pub workspace_root: String,
    pub skill_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_bundled_skill_has_a_valid_id_and_nonempty_files() {
        assert!(!BUNDLED_SKILLS.is_empty(), "内置技能清单不该为空");
        for skill in BUNDLED_SKILLS {
            assert!(
                validate_skill_id(skill.id).is_ok(),
                "内置技能 id 必须是合法小写 slug: {:?}",
                skill.id
            );
            assert!(!skill.name.is_empty());
            assert!(!skill.description.is_empty());
            assert!(!skill.files.is_empty(), "{} 没有任何文件", skill.id);
            assert!(
                skill.files.iter().any(|file| file.path == "SKILL.md"),
                "{} 缺少 SKILL.md（ACP agent 靠它识别技能）",
                skill.id
            );
            // 内容真的嵌进来了，不是空串。
            for file in skill.files {
                assert!(
                    !file.contents.trim().is_empty(),
                    "{}/{} 内容为空",
                    skill.id,
                    file.path
                );
            }
        }
    }

    #[test]
    fn list_reports_every_skill_with_its_files() {
        let listed = skills_bundled_list();
        assert_eq!(listed.len(), BUNDLED_SKILLS.len());
        let ffmpeg = listed
            .iter()
            .find(|meta| meta.id == "ffmpeg-media")
            .expect("ffmpeg-media 应在内置清单里");
        assert_eq!(ffmpeg.files, vec!["SKILL.md".to_string()]);
    }

    #[test]
    fn install_rejects_unknown_id_and_relative_root() {
        let tmp = std::env::temp_dir().to_string_lossy().to_string();
        // 非内置 id
        let err = skills_install_bundled(tmp.clone(), "no-such-skill".to_string())
            .expect_err("未收录的 id 应被拒绝");
        assert!(err.contains("不是内置技能"), "实际错误：{err}");
        // 相对工作区路径
        assert!(
            skills_install_bundled("relative/path".to_string(), "ffmpeg-media".to_string())
                .is_err()
        );
    }

    #[test]
    fn install_writes_skill_md_into_the_workspace() {
        let root = std::env::temp_dir().join(format!("gw-bundled-skill-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let report = skills_install_bundled(
            root.to_string_lossy().to_string(),
            "ffmpeg-media".to_string(),
        )
        .expect("内置技能应能安装");
        assert_eq!(report.files_written, 1);
        let skill_md = root.join(".agents/skills/ffmpeg-media/SKILL.md");
        assert!(
            skill_md.exists(),
            "SKILL.md 应落在 .agents/skills/ffmpeg-media/"
        );
        let text = std::fs::read_to_string(&skill_md).unwrap();
        assert!(text.starts_with("---"), "SKILL.md 应带 frontmatter");

        // 覆盖安装幂等
        let again = skills_install_bundled(
            root.to_string_lossy().to_string(),
            "ffmpeg-media".to_string(),
        )
        .expect("重复安装应成功（覆盖更新）");
        assert_eq!(again.files_written, 1);

        let _ = std::fs::remove_dir_all(&root);
    }
}
