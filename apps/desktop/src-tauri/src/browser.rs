//! 内嵌浏览器：主窗口里的单个 child webview，渲染**不可信远端内容**。
//!
//! 安全模型（与 `plugin_window` 的「插件拿不到窗口句柄」同一思路，方向相反）：
//! 这个 webview 加载的是任意站点，所以按不可信方隔离 ——
//! - 不注册任何 capability、不加 `remote` 授权：远端 origin 的 IPC 由 Tauri 的
//!   `is_local_url` 判定直接拒绝（`webview/mod.rs` 的 `resolve_command_scope`），
//!   页面拿不到任何宿主命令；
//! - `on_navigation` 只放行 http/https/about/data/blob，挡掉 `file://` 与自定义协议；
//! - `on_new_window` / `on_download` / `on_permission_request` 一律拒绝；
//! - 会话数据落在**专用** `browser-profile` 目录，与主 webview 的存储隔离，
//!   cookie 不会外溢到宿主自己的请求里。
//!
//! 两条创建路径（命令名与行为对外一致）：
//! - **Linux**：`browser_linux` 用 wry 把 webview 直建进一个 `gtk::Fixed` —— Tauri 的
//!   `add_child` 在这边会把子 webview 塞进主窗口默认 GtkBox，位置/尺寸由 GTK 布局决定、
//!   `set_bounds` 也会退化成空操作，落不进预览面板的槽位；
//! - **Windows / macOS**：走 Tauri 的 `Window::add_child`（`build_as_child`，bounds 生效），
//!   需要 cargo `unstable` feature —— `Window::add_child` / `WebviewBuilder` 在 Tauri 2.x
//!   全挂在这个 feature 后面（crate 级 feature，Linux 构建同样开着）。
//!
//! `add_child` 会在主线程建视图并阻塞等结果，所以命令必须是 `async`（在主线程同步调用会死锁）。
//!
//! 单实例：全应用只有 `gw-browser` 一个，跟随当前「浏览器」预览标签。换 URL 走
//! `browser_navigate` 而不是重建，会话 / 滚动 / 表单状态因此得以保留。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use tauri::{AppHandle, Emitter, Url, Wry};

// 下面几组只在非 Linux 路径用：Linux 上子 webview 由 `browser_linux` 用 wry 直建 ——
// Tauri 的 `add_child` 在 Linux 走 `build_gtk(default_vbox)`，坐标会被 GTK 布局吃掉
// （详见 browser_linux.rs 顶部）。非 Linux 平台维持原样。
#[cfg(not(target_os = "linux"))]
use std::path::PathBuf;
#[cfg(not(target_os = "linux"))]
use tauri::webview::{NewWindowResponse, PageLoadEvent, PermissionResponse, WebviewBuilder};
#[cfg(not(target_os = "linux"))]
use tauri::{LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl};

use crate::tray::MAIN_WINDOW;

/// 子 webview 的 label（全应用唯一）。
///
/// 只有非 Linux 路径用得上：那边 webview 注册在 Tauri 的 webview 表里、按 label 找；
/// Linux 的 webview 由 wry 直建，句柄存在 `BrowserState::linux`。
#[cfg(not(target_os = "linux"))]
pub const BROWSER_LABEL: &str = "gw-browser";
/// 宿主 → 主窗口的合并状态事件。**只发给主窗口**，绝不发给子 webview。
pub const EVENT_STATE: &str = "browser:state";

/// 宿主侧浏览器状态。
///
/// 约定**不持有 webview 句柄**（非 Linux 平台句柄归 Tauri 的 webview 表托管，drop 掉这里的
/// 值不会关窗）—— 只存几个可克隆的共享句柄，供 builder 回调与命令两侧共用。
/// Linux 走的自建路径没有 Tauri 的 webview 表，句柄另存在 `linux` 字段里。
pub struct BrowserState {
    visible: AtomicBool,
    pub(crate) history: Arc<Mutex<NavHistory>>,
    pub(crate) title: Arc<Mutex<String>>,
    /// 自建 webview 的句柄与承载它的 GtkFixed（Linux 专属，详见 browser_linux.rs）。
    #[cfg(target_os = "linux")]
    pub(crate) linux: crate::browser_linux::LinuxBrowser,
}

impl Default for BrowserState {
    fn default() -> Self {
        Self {
            visible: AtomicBool::new(false),
            history: Arc::new(Mutex::new(NavHistory::default())),
            title: Arc::new(Mutex::new(String::new())),
            #[cfg(target_os = "linux")]
            linux: crate::browser_linux::LinuxBrowser::default(),
        }
    }
}

impl BrowserState {
    pub(crate) fn is_visible(&self) -> bool {
        self.visible.load(Ordering::Relaxed)
    }

    pub(crate) fn set_visible(&self, visible: bool) {
        self.visible.store(visible, Ordering::Relaxed);
    }

    /// 子 webview 关闭后清空，避免下次打开时残留上一次的标题 / 导航栈。
    pub(crate) fn reset(&self) {
        self.set_visible(false);
        self.history
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
        self.title
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }
}

/// 宿主 → 渲染端的浏览器状态快照（单条合并事件，字段随 `rename_all` 转 camelCase）。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserStateEvent {
    url: String,
    title: String,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
}

/// 导航栈：自校正的「前进 / 后退 / 新导航」判定。
///
/// `on_navigation` 对**所有**导航都触发，包括 `history.back()` 引起的那些 —— 若一律
/// 当新导航入栈，后退反而会把栈越撑越长。这里靠「新 URL 恰好等于前一项 / 后一项」
/// 来识别历史移动，不需要额外的 pending 标志，天然自校正。
#[derive(Default)]
pub(crate) struct NavHistory {
    entries: Vec<String>,
    cursor: usize,
}

impl NavHistory {
    pub(crate) fn push(&mut self, url: &str) {
        if self.entries.is_empty() {
            self.entries.push(url.to_string());
            self.cursor = 0;
            return;
        }
        // 后退：新地址 == 当前项的前一项。
        if self.cursor > 0 && self.entries[self.cursor - 1] == url {
            self.cursor -= 1;
            return;
        }
        // 前进：新地址 == 当前项的后一项。
        if self.cursor + 1 < self.entries.len() && self.entries[self.cursor + 1] == url {
            self.cursor += 1;
            return;
        }
        // 重载 / 重定向回原址：不入栈，否则每次刷新都会长一节。
        if self.entries[self.cursor] == url {
            return;
        }
        // 真·新导航：截断前进分支再追加。
        self.entries.truncate(self.cursor + 1);
        self.entries.push(url.to_string());
        self.cursor = self.entries.len() - 1;
    }

    pub(crate) fn can_back(&self) -> bool {
        !self.entries.is_empty() && self.cursor > 0
    }

    pub(crate) fn can_forward(&self) -> bool {
        !self.entries.is_empty() && self.cursor + 1 < self.entries.len()
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.cursor = 0;
    }
}

/// 允许导航到的协议白名单：只放行正常网页与内联资源，挡掉 `file://` 与自定义协议。
pub(crate) fn allowed_scheme(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "about" | "data" | "blob")
}

/// 解析并校验一个可导航地址；协议不在白名单直接拒绝。
pub(crate) fn parse_navigable(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|error| format!("无效地址 {raw}: {error}"))?;
    if !allowed_scheme(&url) {
        return Err(format!("内嵌浏览器不支持 {} 协议", url.scheme()));
    }
    Ok(url)
}

/// 把坐标收敛到 0.5px 网格（避免子像素抖动导致的重复重排），并把四项都夹到 ≥ 0 ——
/// 槽位永远在窗口客户区内，负坐标只可能来自布局竞态，喂给宿主只会得到非法位置。
pub(crate) fn sanitize_rect(x: f64, y: f64, width: f64, height: f64) -> (f64, f64, f64, f64) {
    let quantize = |value: f64| ((value * 2.0).round() / 2.0).max(0.0);
    (quantize(x), quantize(y), quantize(width), quantize(height))
}

#[cfg(not(target_os = "linux"))]
fn apply_bounds(webview: &Webview, rect: (f64, f64, f64, f64)) -> Result<(), String> {
    webview
        .set_position(LogicalPosition::new(rect.0, rect.1))
        .map_err(|error| error.to_string())?;
    webview
        .set_size(LogicalSize::new(rect.2, rect.3))
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// 组装并发出状态事件（读导航栈 / 标题的当前快照）。
///
/// 泛型是因为两条路径的事件源不同：非 Linux 用 `Webview::emit_to`，Linux 的自建
/// webview 只是 wry 的对象、不是 Tauri 的 `Emitter`，只能用 `AppHandle` 发。
pub(crate) fn emit_state_payload<E: Emitter<Wry>>(
    emitter: &E,
    history: &Mutex<NavHistory>,
    title: &Mutex<String>,
    url: String,
    loading: bool,
) {
    let (can_go_back, can_go_forward) = {
        let history = history.lock().unwrap_or_else(PoisonError::into_inner);
        (history.can_back(), history.can_forward())
    };
    let title = title.lock().unwrap_or_else(PoisonError::into_inner).clone();
    let payload = BrowserStateEvent {
        url,
        title,
        loading,
        can_go_back,
        can_go_forward,
    };
    let _ = emitter.emit_to(MAIN_WINDOW, EVENT_STATE, payload);
}

/// 非 Linux 路径的事件回推：从子 webview 自己发（它属于主窗口）。
#[cfg(not(target_os = "linux"))]
fn emit_state(
    webview: &Webview,
    history: &Mutex<NavHistory>,
    title: &Mutex<String>,
    url: String,
    loading: bool,
) {
    emit_state_payload(webview, history, title, url, loading);
}

/// 构造子 webview 的 builder（只在首次 `browser_open` 时用一次）。
#[cfg(not(target_os = "linux"))]
fn build_browser(
    url: Url,
    data_dir: PathBuf,
    history: Arc<Mutex<NavHistory>>,
    title: Arc<Mutex<String>>,
) -> WebviewBuilder<Wry> {
    let nav_history = Arc::clone(&history);
    let title_for_title = Arc::clone(&title);
    let history_for_title = Arc::clone(&history);
    let title_for_load = Arc::clone(&title);
    let history_for_load = Arc::clone(&history);

    WebviewBuilder::<Wry>::new(BROWSER_LABEL, WebviewUrl::External(url))
        // 专用数据目录 + 非隐身：登录态跨重启保留，且与主 webview 隔离。
        .data_directory(data_dir)
        .incognito(false)
        // 关掉 Ctrl+滚轮缩放：缩放会让「DOM 给的逻辑坐标」与页面视觉错位，读起来像 bug。
        .zoom_hotkeys_enabled(false)
        .focused(false)
        .on_navigation(move |url| {
            if !allowed_scheme(url) {
                return false;
            }
            nav_history
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(url.as_str());
            true
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .on_permission_request(|_, _| PermissionResponse::Deny)
        .on_document_title_changed(move |webview, new_title| {
            *title_for_title
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = new_title;
            let url = webview.url().map(|url| url.to_string()).unwrap_or_default();
            emit_state(&webview, &history_for_title, &title_for_title, url, false);
        })
        .on_page_load(move |webview, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            emit_state(
                &webview,
                &history_for_load,
                &title_for_load,
                payload.url().to_string(),
                loading,
            );
        })
}

/// 打开（或复用）内嵌浏览器并定位到给定矩形。
///
/// 已存在则导航 + 重新定位 + 显示；否则在主窗口下创建子 webview。
/// 两条平台的创建路径见模块头注释。
#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return crate::browser_linux::open(app, url, x, y, width, height).await;

    #[cfg(not(target_os = "linux"))]
    {
        let rect = sanitize_rect(x, y, width, height);
        let parsed = parse_navigable(&url)?;

        if let Some(webview) = app.get_webview(BROWSER_LABEL) {
            webview
                .navigate(parsed)
                .map_err(|error| error.to_string())?;
            apply_bounds(&webview, rect)?;
            webview.show().map_err(|error| error.to_string())?;
            app.state::<BrowserState>().set_visible(true);
            return Ok(());
        }

        let window = app
            .get_window(MAIN_WINDOW)
            .ok_or_else(|| "主窗口不存在".to_string())?;
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("解析应用数据目录失败: {error}"))?
            .join("browser-profile");
        let (history, title) = {
            let state = app.state::<BrowserState>();
            (Arc::clone(&state.history), Arc::clone(&state.title))
        };
        let builder = build_browser(parsed, data_dir, history, title);
        window
            .add_child(
                builder,
                LogicalPosition::new(rect.0, rect.1),
                LogicalSize::new(rect.2, rect.3),
            )
            .map_err(|error| format!("创建内嵌浏览器失败: {error}"))?;
        app.state::<BrowserState>().set_visible(true);
        Ok(())
    }
}

/// 把子 webview 对齐到渲染端给的槽位矩形（逻辑像素，窗口客户区坐标系）。
#[tauri::command]
pub async fn browser_set_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return crate::browser_linux::set_bounds(app, x, y, width, height).await;

    #[cfg(not(target_os = "linux"))]
    {
        let Some(webview) = app.get_webview(BROWSER_LABEL) else {
            return Ok(());
        };
        apply_bounds(&webview, sanitize_rect(x, y, width, height))
    }
}

/// 显示 / 隐藏子 webview。渲染端在面板折叠、窗口失焦、或宿主弹层打开时调它。
#[tauri::command]
pub async fn browser_set_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return crate::browser_linux::set_visible(app, visible).await;

    #[cfg(not(target_os = "linux"))]
    {
        let Some(webview) = app.get_webview(BROWSER_LABEL) else {
            return Ok(());
        };
        let state = app.state::<BrowserState>();
        if state.is_visible() == visible {
            return Ok(());
        }
        let result = if visible {
            webview.show()
        } else {
            webview.hide()
        };
        result.map_err(|error| error.to_string())?;
        state.set_visible(visible);
        Ok(())
    }
}

/// 导航到新地址（复用同一个子 webview，保留会话）。
#[tauri::command]
pub async fn browser_navigate(app: AppHandle, url: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return crate::browser_linux::navigate(app, url).await;

    #[cfg(not(target_os = "linux"))]
    {
        let Some(webview) = app.get_webview(BROWSER_LABEL) else {
            return Ok(());
        };
        webview
            .navigate(parse_navigable(&url)?)
            .map_err(|error| error.to_string())
    }
}

/// 后退。Tauri 2.x 没有 `go_back`，只能借页面自己的 `history`；导航栈由
/// `on_navigation` 自校正，页面加载后再由 `on_page_load` 回推状态。
#[tauri::command]
pub async fn browser_back(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return crate::browser_linux::back(app).await;

    #[cfg(not(target_os = "linux"))]
    {
        let Some(webview) = app.get_webview(BROWSER_LABEL) else {
            return Ok(());
        };
        webview
            .eval("window.history.back()")
            .map_err(|error| error.to_string())
    }
}

/// 前进。同 [`browser_back`] 的取舍。
#[tauri::command]
pub async fn browser_forward(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return crate::browser_linux::forward(app).await;

    #[cfg(not(target_os = "linux"))]
    {
        let Some(webview) = app.get_webview(BROWSER_LABEL) else {
            return Ok(());
        };
        webview
            .eval("window.history.forward()")
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub async fn browser_reload(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return crate::browser_linux::reload(app).await;

    #[cfg(not(target_os = "linux"))]
    {
        let Some(webview) = app.get_webview(BROWSER_LABEL) else {
            return Ok(());
        };
        webview.reload().map_err(|error| error.to_string())
    }
}

/// 停止加载（Tauri 没有 stop，用 `window.stop()`）。
#[tauri::command]
pub async fn browser_stop(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return crate::browser_linux::stop(app).await;

    #[cfg(not(target_os = "linux"))]
    {
        let Some(webview) = app.get_webview(BROWSER_LABEL) else {
            return Ok(());
        };
        webview
            .eval("window.stop()")
            .map_err(|error| error.to_string())
    }
}

/// 销毁子 webview 并清空状态。
#[tauri::command]
pub async fn browser_close(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return crate::browser_linux::close(app).await;

    #[cfg(not(target_os = "linux"))]
    {
        if let Some(webview) = app.get_webview(BROWSER_LABEL) {
            webview.close().map_err(|error| error.to_string())?;
        }
        app.state::<BrowserState>().reset();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nav_history_tracks_new_navigation() {
        let mut history = NavHistory::default();
        assert!(!history.can_back());
        assert!(!history.can_forward());

        history.push("https://a.test/");
        assert!(!history.can_back());
        history.push("https://b.test/");
        assert!(history.can_back());
        assert!(!history.can_forward());

        // 从中间再导航：当前址重复 push 是重载吸收（宿主没有 load-cause 信号，
        // 重载全靠它吸收），不动前进分支；真·新导航才截断前进分支。
        history.push("https://a.test/");
        assert_eq!(history.cursor, 0);
        history.push("https://a.test/");
        assert!(history.can_forward());
        history.push("https://c.test/");
        assert_eq!(history.entries, vec!["https://a.test/", "https://c.test/"]);
        assert_eq!(history.cursor, 1);
        assert!(!history.can_forward());
    }

    #[test]
    fn nav_history_recognizes_back_and_forward_without_growing() {
        let mut history = NavHistory::default();
        history.push("https://a.test/");
        history.push("https://b.test/");
        history.push("https://c.test/");
        assert_eq!(history.cursor, 2);

        // 后退：新地址等于前一项 → 游标回退，栈不增长。
        history.push("https://b.test/");
        assert_eq!(history.cursor, 1);
        assert_eq!(history.entries.len(), 3);
        assert!(history.can_back());
        assert!(history.can_forward());

        // 再后退到首项。
        history.push("https://a.test/");
        assert_eq!(history.cursor, 0);
        assert!(!history.can_back());
        assert!(history.can_forward());

        // 前进：新地址等于后一项 → 游标前进。
        history.push("https://b.test/");
        assert_eq!(history.cursor, 1);
        assert_eq!(history.entries.len(), 3);
    }

    #[test]
    fn nav_history_ignores_reload() {
        let mut history = NavHistory::default();
        history.push("https://a.test/");
        history.push("https://b.test/");
        history.push("https://b.test/");
        assert_eq!(history.entries.len(), 2);
        assert_eq!(history.cursor, 1);
    }

    #[test]
    fn nav_history_clear_resets() {
        let mut history = NavHistory::default();
        history.push("https://a.test/");
        history.push("https://b.test/");
        history.clear();
        assert!(history.entries.is_empty());
        assert_eq!(history.cursor, 0);
        assert!(!history.can_back());
        assert!(!history.can_forward());
    }

    #[test]
    fn scheme_allowlist_blocks_local_and_custom_schemes() {
        for allowed in [
            "https://example.com/",
            "http://localhost:5173/",
            "about:blank",
            "data:text/plain,hi",
            "blob:https://example.com/x",
        ] {
            let url = Url::parse(allowed).unwrap();
            assert!(allowed_scheme(&url), "{allowed} 应放行");
        }
        for blocked in ["file:///etc/passwd", "tauri://localhost/", "ftp://x.test/"] {
            let url = Url::parse(blocked).unwrap();
            assert!(!allowed_scheme(&url), "{blocked} 应拒绝");
        }
    }

    #[test]
    fn parse_navigable_rejects_unsupported_scheme() {
        assert!(parse_navigable("https://example.com/").is_ok());
        let error = parse_navigable("file:///etc/passwd").unwrap_err();
        assert!(error.contains("file"), "错误信息应点出协议: {error}");
        assert!(parse_navigable("not a url").is_err());
    }

    #[test]
    fn sanitize_rect_clamps_and_quantizes() {
        assert_eq!(
            sanitize_rect(10.2, 20.3, 300.24, 400.26),
            (10.0, 20.5, 300.0, 400.5)
        );
        // 负值与 NaN 一律夹到 0（`f64::max` 遇到 NaN 取另一侧）。
        assert_eq!(
            sanitize_rect(-1.0, -2.0, -5.0, f64::NAN),
            (0.0, 0.0, 0.0, 0.0)
        );
    }
}
