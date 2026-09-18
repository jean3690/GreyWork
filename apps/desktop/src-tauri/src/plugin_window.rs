//! 插件脱窗显示（OS 级悬浮窗）宿主。
//!
//! 安全模型：插件代码永远拿不到窗口句柄。窗口的创建/关闭由宿主命令完成，
//! 且仅当满足全部条件才放行：
//! - 插件已安装且落盘（list_installed 语义，非内存注册表）；
//! - manifest 显式声明 `window` 块（尺寸有界 ≤512）—— 未声明即无脱窗能力；
//! - 是 worker 包且带 render 循环（窗口内容 = render 指令流）；
//! - 窗口内容 = 同一受控渲染管线，无插件 JS 直达。
//!
//! 前端在插件 requires 含 `window.floating` 且用户已授权时才显示「弹出桌面」按钮
//! （门禁在 runtime.ts 授权集，见 capabilities.ts 的 window.floating 目录项）。

use std::path::PathBuf;

use tauri::Manager;
use tauri::{Emitter, WebviewUrl, WebviewWindowBuilder};

use crate::plugin_market::{MarketPluginManifest, PluginKind, PluginPackage};

/// 窗口 label 前缀：`plugin-window-<plugin-id>`，前端按 label 反查插件 id。
const PLUGIN_WINDOW_PREFIX: &str = "plugin-window-";

fn plugins_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("plugins"))
        .map_err(|error| format!("resolve app data directory failed: {error}"))
}

/// 读取并校验某插件的落盘包；窗口资格判定。
fn load_window_plugin(app: &tauri::AppHandle, plugin_id: &str) -> Result<PluginPackage, String> {
    crate::plugin_market::validate_dir_key(plugin_id, "plugin id")?;
    let root = plugins_root(app)?.join(plugin_id);
    let bytes = std::fs::read(root.join("plugin.json"))
        .map_err(|_| format!("plugin not installed: {plugin_id}"))?;
    let package: PluginPackage = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid plugin package JSON: {error}"))?;
    if package.manifest.id != plugin_id {
        return Err("plugin package id mismatch".to_string());
    }
    if !can_open_plugin_window(&package.manifest) {
        return Err(format!(
            "plugin {plugin_id} is not eligible for a floating window (needs worker kind + render loop + window declaration)"
        ));
    }
    Ok(package)
}

/// 打开（或前置）插件的悬浮窗。幂等：已存在则置顶并聚焦。
#[tauri::command]
pub async fn plugin_window_open(app: tauri::AppHandle, plugin_id: String) -> Result<(), String> {
    let package = load_window_plugin(&app, &plugin_id)?;
    let window = package.manifest.window.unwrap(); // 上面已判存在
    let label = format!("{PLUGIN_WINDOW_PREFIX}{plugin_id}");

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(&package.manifest.name)
        .inner_size(window.width as f64, window.height as f64)
        .min_inner_size(64.0, 64.0)
        // 悬浮宠物形态：透明底、无装饰、置顶、不占任务栏、禁缩放。
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(true)
        .build()
        .map_err(|error| format!("create pet window failed: {error}"))?;

    // 窗口加载同 bundle：前端 #/pet 隐藏路由按窗口 label 渲染对应插件。
    let _ = win;
    Ok(())
}

/// 关闭插件的悬浮窗（卸载/停用插件时前端调用）。
#[tauri::command]
pub async fn plugin_window_close(app: tauri::AppHandle, plugin_id: String) -> Result<(), String> {
    let label = format!("{PLUGIN_WINDOW_PREFIX}{plugin_id}");
    if let Some(window) = app.get_webview_window(&label) {
        window
            .close()
            .map_err(|error| format!("close pet window failed: {error}"))?;
    }
    Ok(())
}

/// 窗口事件通道：前端（主窗）经此发布状态更新事件到窗口内（预留；当前窗口自含 worker）。
#[allow(dead_code)]
pub fn plugin_window_emit(
    app: &tauri::AppHandle,
    plugin_id: &str,
    event: &str,
    payload: serde_json::Value,
) {
    let label = format!("{PLUGIN_WINDOW_PREFIX}{plugin_id}");
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.emit(event, payload);
    }
}

/// 测试辅助：窗口资格判定不依赖真实 AppHandle 的纯函数。
pub fn can_open_plugin_window(manifest: &MarketPluginManifest) -> bool {
    manifest.window.is_some()
        && manifest.kind == PluginKind::Worker
        && manifest
            .runtime
            .as_ref()
            .and_then(|runtime| runtime.render.as_ref())
            .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_market::{
        CodePluginRuntime, DeclarativeContributions, DeclarativeMode, DeclarativePage, RenderLoop,
    };

    fn worker_manifest(window: Option<(u32, u32)>) -> MarketPluginManifest {
        MarketPluginManifest {
            id: "demo.pet".into(),
            name: "Demo Pet".into(),
            version: "1.0.0".into(),
            description: None,
            kind: PluginKind::Worker,
            runtime: Some(CodePluginRuntime {
                runtime_type: "worker".into(),
                entry: "https://raw.githubusercontent.com/acme/demo/main/demo.js".into(),
                sha256: "a".repeat(64),
                render: Some(RenderLoop {
                    handler: "draw".into(),
                    fps: Some(12),
                    width: Some(160),
                    height: Some(150),
                }),
            }),
            requires: vec![],
            window: window
                .map(|(width, height)| crate::plugin_market::PluginWindowDecl { width, height }),
            contributes: DeclarativeContributions {
                modes: vec![DeclarativeMode {
                    id: "pet".into(),
                    title: "Pet".into(),
                    icon: None,
                    page: DeclarativePage {
                        eyebrow: None,
                        heading: "h".into(),
                        body: "b".into(),
                        counter_label: None,
                        fields: vec![],
                        outputs: vec![],
                        actions: vec![],
                    },
                }],
                ui_regions: vec![],
            },
        }
    }

    #[test]
    fn plugin_window_eligibility_requires_window_decl_render_worker() {
        // 全部满足：放行。
        assert!(can_open_plugin_window(&worker_manifest(Some((160, 150)))));
        // 无 window 声明：拒绝。
        assert!(!can_open_plugin_window(&worker_manifest(None)));
        // declarative 包（带 window 声明也无 render）：拒绝。
        let mut declarative = worker_manifest(Some((160, 150)));
        declarative.kind = PluginKind::Declarative;
        declarative.runtime = None;
        assert!(!can_open_plugin_window(&declarative));
        // worker 但无 render：拒绝。
        let mut no_render = worker_manifest(Some((160, 150)));
        no_render.runtime.as_mut().unwrap().render = None;
        assert!(!can_open_plugin_window(&no_render));
    }
}
