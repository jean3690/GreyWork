//! 插件脱窗显示（OS 级悬浮窗）宿主。
//!
//! 安全模型：插件代码永远拿不到窗口句柄。窗口的创建/关闭由宿主命令完成，
//! 且仅当满足全部条件才放行：
//! - 插件已安装且落盘（list_installed 语义，非内存注册表）；
//! - manifest 显式声明 `window` 块（尺寸有界 ≤512）—— 未声明即无脱窗能力；
//! - manifest `requires` 含 `window.floating`（受控能力，用户授权门禁的输入）；
//! - 是 worker 包且带 render 循环（窗口内容 = render 指令流）；
//! - 窗口内容 = 同一受控渲染管线，无插件 JS 直达。
//!
//! 前端在 window.floating 已授权时才显示「弹出桌面」按钮（门禁在 runtime.ts 授权集，
//! 见 capabilities.ts 的 window.floating 目录项）；宿主命令再校验声明，纵深防御。

use std::path::PathBuf;

use tauri::Manager;
use tauri::{WebviewUrl, WebviewWindowBuilder};

use crate::plugin_market::{MarketPluginManifest, PluginKind, PluginPackage, PluginWindowDecl};

/// 窗口 label 前缀：`plugin-window-<plugin-id>`，前端按 label 反查插件 id。
const PLUGIN_WINDOW_PREFIX: &str = "plugin-window-";

fn plugins_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("plugins"))
        .map_err(|error| format!("resolve app data directory failed: {error}"))
}

/// 读取并校验某插件的落盘包；窗口资格判定。返回校验后的 window 声明，
/// 让「窗口一定存在」的事实由返回值承载，调用点无需再 unwrap。
fn load_window_plugin(
    app: &tauri::AppHandle,
    plugin_id: &str,
) -> Result<(PluginPackage, PluginWindowDecl), String> {
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
            "plugin {plugin_id} is not eligible for a floating window (needs worker kind + render loop + window declaration + window.floating capability)"
        ));
    }
    // can_open_plugin_window 已保证 window.is_some()；take 出已校验声明由返回值承载。
    let window = package
        .manifest
        .window
        .expect("can_open_plugin_window guarantees a window declaration");
    Ok((package, window))
}

/// 打开（或前置）插件的悬浮窗。幂等：已存在则置顶并聚焦。
#[tauri::command]
pub async fn plugin_window_open(app: tauri::AppHandle, plugin_id: String) -> Result<(), String> {
    let (package, window) = load_window_plugin(&app, &plugin_id)?;
    let label = format!("{PLUGIN_WINDOW_PREFIX}{plugin_id}");

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }

    // 窗口加载同 bundle：前端 #/plugin-window 隐藏路由按窗口 label 渲染对应插件。
    // 句柄交给 Tauri 的窗口表托管，drop 返回值不会关闭窗口。
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
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
        .map_err(|error| format!("create plugin window failed: {error}"))?;
    Ok(())
}

/// 关闭插件的悬浮窗（卸载/停用插件时前端调用）。
#[tauri::command]
pub async fn plugin_window_close(app: tauri::AppHandle, plugin_id: String) -> Result<(), String> {
    let label = format!("{PLUGIN_WINDOW_PREFIX}{plugin_id}");
    if let Some(window) = app.get_webview_window(&label) {
        window
            .close()
            .map_err(|error| format!("close plugin window failed: {error}"))?;
    }
    Ok(())
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
        && crate::plugin_market::declares_window_floating(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_market::{
        CapabilityRequirement, CodePluginRuntime, DeclarativeContributions, DeclarativeMode,
        DeclarativePage, RenderLoop,
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
            requires: vec![CapabilityRequirement::Plain("window.floating".into())],
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
        // 未声明 window.floating 能力：拒绝（宿主侧纵深校验）。
        let mut undeclared = worker_manifest(Some((160, 150)));
        undeclared.requires = vec![];
        assert!(!can_open_plugin_window(&undeclared));
    }
}
