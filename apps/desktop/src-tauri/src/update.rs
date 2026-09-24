//! 检查更新的桌面命令入口 + 用系统浏览器打开外部链接。
//!
//! 「检查更新」的实现收在 `greywork_host::update`（与 headless 服务端共用）；
//! 「打开链接」是纯宿主能力（系统浏览器），留在桌面壳。

use tauri_plugin_opener::OpenerExt;

pub use greywork_host::update::LatestRelease;

/// 拉取最新 Release 供渲染端与当前版本比对。
#[tauri::command]
pub async fn check_update() -> Result<LatestRelease, String> {
    greywork_host::update::check_update().await
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
