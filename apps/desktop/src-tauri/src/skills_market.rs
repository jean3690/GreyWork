//! 技能市场宿主代理。
//!
//! 渲染端不直连外网（CSP 不放行市场域名）：搜索/下载经本模块转发 skills.sh，
//! 安装把快照文件写入工作区 `.agents/skills/<skillId>/` —— 该目录是外部 ACP
//! agent（opencode / claude-code / codex 等）的原生技能目录，装完即被识别。
//!
//! 安全约束：
//! - 远端文件内容不可信：安装前逐文件做路径净化（拒绝 `..`、绝对路径、反斜杠、
//!   超深层级），限制文件数与单文件体积；
//! - skillId 强制小写 slug 格式，卸载只允许删除技能根目录本身。

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

const DEFAULT_MARKET_ORIGIN: &str = "https://www.skills.sh";
const MAX_FILES_PER_SKILL: usize = 128;
const MAX_FILE_BYTES: usize = 256 * 1024;
const SKILL_ID_MAX_CHARS: usize = 64;

/// skills.sh 搜索结果条目（归一化）。
#[derive(Debug, Clone, Serialize)]
pub struct MarketSkillEntry {
    /// 完整引用："owner/repo/skillId"；site 源（如 open.feishu.cn/lark-doc）不可下载。
    #[serde(rename = "ref")]
    pub reference: String,
    pub skill_id: String,
    pub name: String,
    pub installs: u64,
    pub source: String,
    /// 是否可经 download 端点拉取（GitHub 仓库源）。
    pub downloadable: bool,
}

/// 远端技能快照文件。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SkillSnapshotFile {
    pub path: String,
    pub contents: String,
}

/// 下载端点返回的完整快照。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SkillSnapshot {
    pub files: Vec<SkillSnapshotFile>,
    pub hash: String,
}

#[derive(Debug, Serialize)]
pub struct InstallReport {
    pub dir: String,
    pub files_written: usize,
}

/// 工作区目录校验：绝对路径 + 已存在目录 + 非文件系统根（与 acp_host 同规则）。
fn validate_workspace_root(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    let path = PathBuf::from(trimmed);
    if trimmed.is_empty() || !path.is_absolute() {
        return Err(format!(
            "workspace root must be an absolute path, got: {raw:?}"
        ));
    }
    let normalized = trimmed.replace('\\', "/");
    if normalized == "/"
        || (normalized.len() == 3 && normalized.as_bytes()[1] == b':' && normalized.ends_with('/'))
    {
        return Err("workspace root must not be a filesystem root".to_string());
    }
    if !path.is_dir() {
        return Err(format!("workspace root does not exist: {}", path.display()));
    }
    Ok(path)
}

/// skillId 强制小写 slug；卸载/安装路径由它构造，格式不严即路径逃逸。
fn validate_skill_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    let valid = !id.is_empty()
        && id.len() <= SKILL_ID_MAX_CHARS
        && id
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if valid {
        Ok(id.to_string())
    } else {
        Err(format!("invalid skill id (expect lowercase slug): {raw:?}"))
    }
}

/// 净化远端声明的相对路径：仅允许正斜杠分隔的非空普通段，拒绝 `..`、反斜杠与超深层级。
fn sanitize_rel_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
    {
        return None;
    }
    let mut out = PathBuf::new();
    let segments = trimmed.split('/');
    let mut depth = 0usize;
    for segment in segments {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return None;
        }
        depth += 1;
        if depth > 16 {
            return None;
        }
        out.push(segment);
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

fn market_origin(origin: Option<&str>) -> String {
    match origin.map(str::trim).filter(|value| !value.is_empty()) {
        Some(custom) => custom.trim_end_matches('/').to_string(),
        None => DEFAULT_MARKET_ORIGIN.to_string(),
    }
}

/// 解析 "owner/repo/skill" 引用；site 源（无三段仓库路径）不可下载。
fn parse_download_ref(reference: &str) -> Result<(String, String, String), String> {
    let parts: Vec<&str> = reference.trim().split('/').collect();
    if parts.len() != 3 {
        return Err(format!(
            "ref is not a downloadable repo skill (expect owner/repo/skill): {reference:?}"
        ));
    }
    for part in &parts {
        if *part == "." || *part == ".." {
            return Err(format!(
                "ref segment must not be a dot segment: {reference:?}"
            ));
        }
        if part.is_empty()
            || !part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            return Err(format!("invalid ref segment {part:?} in {reference:?}"));
        }
    }
    Ok((
        parts[0].to_string(),
        parts[1].to_string(),
        parts[2].to_string(),
    ))
}

/// 搜索聚合索引；site 源同样返回但标记不可下载。
#[tauri::command]
pub async fn skills_search(
    origin: Option<String>,
    query: String,
) -> Result<Vec<MarketSkillEntry>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("query is empty".to_string());
    }
    let url = format!(
        "{}/api/search?q={}",
        market_origin(origin.as_deref()),
        urlencoding_lite(query)
    );
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("http client build failed: {error}"))?;
    let body: serde_json::Value = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("search request failed: {error}"))?
        .json()
        .await
        .map_err(|error| format!("invalid search response: {error}"))?;
    Ok(normalize_search(&body))
}

fn urlencoding_lite(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn normalize_search(body: &serde_json::Value) -> Vec<MarketSkillEntry> {
    body.get("skills")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let reference = str_field(item, "id")?;
                    let skill_id = str_field(item, "skillId")?;
                    Some(MarketSkillEntry {
                        downloadable: reference.split('/').count() == 3,
                        reference,
                        name: str_field(item, "name").unwrap_or_else(|| skill_id.clone()),
                        installs: item
                            .get("installs")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0),
                        source: str_field(item, "source").unwrap_or_default(),
                        skill_id,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn str_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .filter(|raw| !raw.is_empty())
        .map(str::to_string)
}

/// 拉取技能全量文件快照（仅 GitHub 仓库源）。
#[tauri::command]
pub async fn skills_download(
    origin: Option<String>,
    entry_ref: String,
) -> Result<SkillSnapshot, String> {
    let (owner, repo, slug) = parse_download_ref(&entry_ref)?;
    let url = format!(
        "{}/api/download/{}/{}/{}",
        market_origin(origin.as_deref()),
        urlencode_segment(&owner),
        urlencode_segment(&repo),
        urlencode_segment(&slug)
    );
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("http client build failed: {error}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("download request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("download endpoint returned {status}"));
    }
    let snapshot: SkillSnapshot = response
        .json()
        .await
        .map_err(|error| format!("invalid snapshot response: {error}"))?;
    if snapshot.files.len() > MAX_FILES_PER_SKILL {
        return Err(format!(
            "snapshot too large: {} files (max {MAX_FILES_PER_SKILL})",
            snapshot.files.len()
        ));
    }
    Ok(snapshot)
}

fn urlencode_segment(value: &str) -> String {
    urlencoding_lite(value)
}

/// 把快照写入 `<workspaceRoot>/.agents/skills/<skillId>/`。
#[tauri::command]
pub async fn skills_install(
    workspace_root: String,
    skill_id: String,
    files: Vec<SkillSnapshotFile>,
) -> Result<InstallReport, String> {
    let root = validate_workspace_root(&workspace_root)?;
    let id = validate_skill_id(&skill_id)?;
    if files.is_empty() {
        return Err("snapshot has no files".to_string());
    }
    if files.len() > MAX_FILES_PER_SKILL {
        return Err(format!(
            "too many files: {} (max {MAX_FILES_PER_SKILL})",
            files.len()
        ));
    }

    // 两阶段：全部路径与体积先过审，再落盘——可疑快照整体拒绝，不产生部分写入
    let mut sanitized: Vec<(PathBuf, &SkillSnapshotFile)> = Vec::with_capacity(files.len());
    for file in &files {
        let rel = sanitize_rel_path(&file.path)
            .ok_or_else(|| format!("unsafe file path rejected: {:?}", file.path))?;
        if file.contents.len() > MAX_FILE_BYTES {
            return Err(format!(
                "file too large: {:?} (max {MAX_FILE_BYTES} bytes)",
                file.path
            ));
        }
        sanitized.push((rel, file));
    }

    let target = root.join(".agents").join("skills").join(&id);
    std::fs::create_dir_all(&target).map_err(|error| format!("create dir failed: {error}"))?;

    let mut written = 0usize;
    for (rel, file) in &sanitized {
        let dest = target.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create dir failed: {error}"))?;
        }
        std::fs::write(&dest, file.contents.as_bytes())
            .map_err(|error| format!("write {:?} failed: {error}", file.path))?;
        written += 1;
    }

    Ok(InstallReport {
        dir: target.to_string_lossy().to_string(),
        files_written: written,
    })
}

/// 卸载：删除技能根目录。目录由本模块构造，路径逃逸面已被 skillId 白名单收敛。
#[tauri::command]
pub async fn skills_uninstall(workspace_root: String, skill_id: String) -> Result<(), String> {
    let root = validate_workspace_root(&workspace_root)?;
    let id = validate_skill_id(&skill_id)?;
    let target = root.join(".agents").join("skills").join(&id);
    if !target.exists() {
        return Err(format!("skill not installed: {id}"));
    }
    std::fs::remove_dir_all(&target).map_err(|error| format!("remove failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn search_normalizer_marks_site_sources_not_downloadable() {
        let body = json!({
            "skills": [
                { "id": "mattpocock/skills/tdd", "skillId": "tdd", "name": "tdd", "installs": 759925, "source": "mattpocock/skills" },
                { "id": "open.feishu.cn/lark-doc", "skillId": "lark-doc", "installs": 614030, "source": "open.feishu.cn" },
            ],
        });
        let entries = normalize_search(&body);
        assert_eq!(entries.len(), 2);
        assert!(entries[0].downloadable);
        assert_eq!(entries[0].installs, 759_925);
        assert!(!entries[1].downloadable);
        // 缺 skillId 的脏数据被丢弃
        assert!(normalize_search(&json!({ "skills": [{ "id": "x/y/z" }] })).is_empty());
    }

    #[test]
    fn download_ref_requires_three_repo_segments() {
        assert!(parse_download_ref("mattpocock/skills/tdd").is_ok());
        assert!(parse_download_ref("open.feishu.cn/lark-doc").is_err());
        assert!(parse_download_ref("../etc/passwd").is_err());
        assert!(parse_download_ref("a/b/c/d").is_err());
        assert!(parse_download_ref("").is_err());
    }

    #[test]
    fn rel_path_sanitizer_blocks_traversal_and_absolutes() {
        assert_eq!(
            sanitize_rel_path("SKILL.md"),
            Some(PathBuf::from("SKILL.md"))
        );
        assert_eq!(
            sanitize_rel_path("references/a.md"),
            Some(PathBuf::from("references").join("a.md"))
        );
        assert_eq!(sanitize_rel_path("../evil"), None);
        assert_eq!(sanitize_rel_path("/etc/passwd"), None);
        assert_eq!(sanitize_rel_path("a\\b.md"), None);
        assert_eq!(sanitize_rel_path(""), None);
        let deep = (0..20).map(|_| "x").collect::<Vec<_>>().join("/");
        assert_eq!(sanitize_rel_path(&deep), None);
    }

    #[test]
    fn skill_id_whitelist_rejects_path_escape() {
        assert!(validate_skill_id("tdd").is_ok());
        assert!(validate_skill_id("web-design-guidelines").is_ok());
        assert!(validate_skill_id("../evil").is_err());
        assert!(validate_skill_id("Big").is_err());
        assert!(validate_skill_id("").is_err());
        assert!(validate_skill_id("-lead").is_err());
    }

    #[test]
    fn workspace_root_validation_matches_acp_rules() {
        assert!(validate_workspace_root("/").is_err());
        assert!(validate_workspace_root("C:/").is_err());
        assert!(validate_workspace_root("relative").is_err());
        assert!(validate_workspace_root(std::env::temp_dir().to_string_lossy().as_ref()).is_ok());
    }

    #[tokio::test]
    async fn install_writes_files_under_agents_skills_and_uninstall_removes() {
        let root = std::env::temp_dir().join(format!("gw-skill-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let report = skills_install(
            root.to_string_lossy().to_string(),
            "demo-skill".to_string(),
            vec![
                SkillSnapshotFile {
                    path: "SKILL.md".into(),
                    contents: "---\nname: demo\n---\nbody".into(),
                },
                SkillSnapshotFile {
                    path: "refs/guide.md".into(),
                    contents: "# Guide".into(),
                },
            ],
        )
        .await
        .expect("clean snapshot installs");

        assert_eq!(report.files_written, 2);
        assert!(root.join(".agents/skills/demo-skill/SKILL.md").exists());
        assert!(root
            .join(".agents/skills/demo-skill/refs/guide.md")
            .exists());

        skills_uninstall(root.to_string_lossy().to_string(), "demo-skill".to_string())
            .await
            .unwrap();
        assert!(!root.join(".agents/skills/demo-skill").exists());

        // 含可疑路径的快照整体拒绝（fail-closed），且不产生部分写入
        let rejected = skills_install(
            root.to_string_lossy().to_string(),
            "demo-skill".to_string(),
            vec![
                SkillSnapshotFile {
                    path: "SKILL.md".into(),
                    contents: "ok".into(),
                },
                SkillSnapshotFile {
                    path: "../escape.md".into(),
                    contents: "evil".into(),
                },
            ],
        )
        .await;
        assert!(rejected.is_err());
        assert!(!root.join(".agents/skills/demo-skill").exists());

        // site 源引用（两段）不可下载
        assert!(parse_download_ref("open.feishu.cn/lark-doc").is_err());

        let _ = std::fs::remove_dir_all(&root);
    }
}
