//! 检查更新 + 打开外部链接。
//!
//! 应用没有内置 updater（未配 tauri-plugin-updater / 签名密钥），所以「更新」= 去
//! GitHub Releases 拉最新版本与发布说明给用户看，点「前往下载」再用系统浏览器打开
//! 发布页。检查更新必须走宿主：渲染端 CSP 的 `connect-src` 只放行 `'self'` 与 ipc，
//! 直接 fetch api.github.com 会被拦；且 GitHub API 要求带 User-Agent。

use serde::Serialize;
use tauri_plugin_opener::OpenerExt;

/// 本项目仓库（README / tauri.conf 的 homepage 同址）。
const REPO_URL: &str = "https://github.com/jean3690/GreyWork";
/// 最新 Release 的 GitHub API。
const LATEST_RELEASE_API: &str = "https://api.github.com/repos/jean3690/GreyWork/releases/latest";

/// 一次「最新发布」的结果（版本号 + 发布说明），交给渲染端与当前版本比对后展示。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestRelease {
    /// 去掉前导 `v` 的版本号（`v0.2.0` → `0.2.0`），供语义化比较。
    pub version: String,
    /// 原始 tag（展示与回退用）。
    pub tag: String,
    /// Release 标题；GitHub 不填时回落到 tag。
    pub name: String,
    /// 发布说明正文（Markdown 原文，渲染端按纯文本展示即可）。
    pub notes: String,
    /// Release 页面地址（「前往下载」打开它）。
    pub url: String,
    /// 发布时间（ISO-8601；可能为空）。
    pub published_at: String,
    /// 是否预发布版本。
    pub prerelease: bool,
}

/// 拉取最新 Release。仓库尚无 Release（404）与网络/解析失败都以 `Err` 返回，
/// 渲染端据 message 呈现「暂无发布版本 / 检查失败」两类提示。
#[tauri::command]
pub async fn check_update() -> Result<LatestRelease, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| format!("构建 HTTP 客户端失败: {error}"))?;

    let response = client
        .get(LATEST_RELEASE_API)
        // GitHub API 无 UA 直接 403；X-GitHub-Api-Version 固定到稳定契约。
        .header(reqwest::header::USER_AGENT, "GreyWork-Updater")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|error| format!("检查更新请求失败: {error}"))?;

    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("仓库尚无发布版本".into());
    }
    if !status.is_success() {
        return Err(format!("检查更新返回状态 {status}"));
    }

    let body = response
        .text()
        .await
        .map_err(|error| format!("读取发布信息失败: {error}"))?;
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|error| format!("解析发布信息失败: {error}"))?;

    let tag = json["tag_name"].as_str().unwrap_or_default().to_string();
    if tag.is_empty() {
        return Err("发布信息缺少版本号".into());
    }
    let version = tag.trim_start_matches(['v', 'V']).to_string();

    Ok(LatestRelease {
        version,
        name: json["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(&tag)
            .to_string(),
        tag,
        notes: json["body"].as_str().unwrap_or_default().to_string(),
        url: json["html_url"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(REPO_URL)
            .to_string(),
        published_at: json["published_at"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        prerelease: json["prerelease"].as_bool().unwrap_or(false),
    })
}

/// 用系统默认浏览器打开外部链接（GitHub 仓库 / Release 页）。
///
/// 只放行 http/https —— 避免被诱导用 opener 打开 `file:` / 自定义协议这类本地目标。
#[tauri::command]
pub async fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("拒绝打开非 http(s) 链接: {url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("打开链接失败: {error}"))
}
