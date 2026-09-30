//! 内嵌浏览器的 **Linux** 实现：用 wry 把 webview 直建进一个 `gtk::Fixed`。
//!
//! # 为什么不能沿用 Tauri 的 `Window::add_child`
//!
//! `tauri-runtime-wry` 在 Linux 上对子 webview 走的是
//! `let vbox = window.default_vbox().unwrap(); webview_builder.build_gtk(vbox)` ——
//! 把它当成主窗口默认 `GtkBox` 里的一个普通子项。wry 的 `add_to_container` 对 `GtkBox`
//! 执行 `pack_start(webview, true, true, 0)`（expand + fill），于是位置/尺寸由 GTK 布局
//! 说了算：子 webview 会和主 webview **平分窗口**；同时 `is_in_fixed_parent = false`
//! 让 `WebView::set_bounds` 退化成空操作 —— 前端算好的槽位矩形完全落不下去。
//!
//! 实测（WSLg + X11）：传 `(100, 100, 400×300)`，webview 出现在窗口下半屏、满宽。
//! wry 官方 README 的结论一致：child webview 要同时支持 X11/Wayland，必须
//! `build_gtk` + `gtk::Fixed`（只有 Fixed 父容器才会 `put(x, y)` + `size_request`，
//! 并把 `is_in_fixed_parent` 置真）。
//!
//! # 布局改造
//!
//! ```text
//! ApplicationWindow
//! └─ GtkBox(vbox)                     ← Tauri 的 default_vbox，仍是窗口唯一子项
//!    └─ GtkOverlay                    ← expand + fill
//!       ├─ 主 WebKitWebView           ← base child：由 Overlay 正常铺满，不需要我们管尺寸
//!       └─ GtkFixed                   ← overlay child：同样铺满，原点 == 窗口内容区左上角
//!          └─ 浏览器 WebKitWebView (槽位矩形)   ← 叠在最上层，按坐标摆放
//! ```
//!
//! 用 Overlay 而不是「把主 webview 也塞进 Fixed」：后者必须给主 webview 一个
//! `set_size_request(整窗大小)` 才能让它铺满，而 size request 就是 GTK 的**最小尺寸**，
//! 于是窗口从此再也缩不小（实测踩到过）。Overlay 的 base child 由容器正常分配，
//! 与窗口尺寸天然联动，也不用我们跟踪 resize。
//!
//! 坐标系不变：GTK 用逻辑像素，前端 `getBoundingClientRect()` 给的就是逻辑像素。
//! 改造**只做一次**且可降级 —— vbox 结构不符合预期（例如多出 GTK 菜单栏）时直接报错，
//! 由前端走已有的 `hostError` 通道说明原因，绝不 panic、也绝不改布局。
//!
//! 安全模型与 `browser.rs` 完全一致（协议白名单 + 导航栈自校正、新窗口 / 下载 / 权限一律
//! 拒绝、专用 `browser-profile` 数据目录）。额外收益：这个 webview 由 wry 直建，
//! **根本不注入 Tauri IPC**，远端页面连被 `is_local_url` 拒绝的机会都没有。

use std::mem::ManuallyDrop;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, PoisonError};

use gtk::prelude::*;
use tauri::{AppHandle, Manager, Url};
use wry::{PageLoadEvent, PermissionResponse, WebViewBuilderExtUnix, WebViewExtUnix};

use crate::browser::{
    allowed_scheme, emit_state_payload, parse_navigable, sanitize_rect, BrowserState,
};
use crate::tray::MAIN_WINDOW;

/// 自建 webview 的句柄。
///
/// `unsafe impl Send` 是为满足 Tauri managed state 的 `Send + Sync` 约束：内部是
/// GTK/WebKit 指针，本身 `!Send`，能否跨界只取决于「有没有真的跨线程用」——
/// 本模块所有访问都收敛在 [`on_main`] 里，即主线程。
/// 用 `ManuallyDrop` 是为了保证它**不会**在非主线程被 drop：进程退出时 managed state
/// 的析构可能落在别的线程，那时宁可泄漏（进程都要没了）也不能在错误线程碰 GTK。
pub struct SendWebView(pub ManuallyDrop<wry::WebView>);

unsafe impl Send for SendWebView {}

/// 承载浏览器 webview 的 `gtk::Fixed`（同样的主线程不变式）。
pub struct SendFixed(pub gtk::Fixed);

unsafe impl Send for SendFixed {}

/// Linux 专属状态：自建 webview 不在 Tauri 的 webview 表里（`app.get_webview` 找不到），
/// 得自己管句柄；容器也要留着，好让后续 `browser_set_bounds` 复用同一个 Fixed。
#[derive(Default)]
pub struct LinuxBrowser {
    pub webview: Mutex<Option<SendWebView>>,
    pub fixed: Mutex<Option<SendFixed>>,
    /// 当前 URL：wry 的标题回调不带 URL 入参，只能自己记一份供事件回推用。
    pub current_url: Arc<Mutex<String>>,
}

/// 所有 GTK/WebKit 操作的主线程入口。
///
/// 命令是 `async`、跑在 worker 线程，而 GTK 只能在主线程碰 —— 统一经这里调度，
/// 结果用 channel 带回。`run_on_main_thread` 在主线程调用时会就地执行，
/// 所以「发送先于接收」不会死锁。
fn on_main<R, F>(app: &AppHandle, run: F) -> Result<R, String>
where
    F: FnOnce(&AppHandle) -> Result<R, String> + Send + 'static,
    R: Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(run(&app_for_main));
    })
    .map_err(|error| format!("调度到主线程失败: {error}"))?;
    rx.recv()
        .map_err(|error| format!("主线程未返回结果: {error}"))?
}

/// 校验主窗口 GTK 结构是否符合预期（纯函数，便于单测）。
///
/// 期望 `default_vbox` 恰好一个 WebKit 子项。多出来通常意味着 GTK 菜单栏或多 webview，
/// 那时把主 webview 搬进 Fixed 会破坏别的布局 —— 宁可让内嵌浏览器不可用。
fn validate_vbox_layout(child_count: usize, first_child_type: Option<&str>) -> Result<(), String> {
    if child_count != 1 {
        return Err(format!(
            "主窗口结构不符合预期：内容区有 {child_count} 个子项（疑似 GTK 菜单栏或多 webview），内嵌浏览器暂不可用"
        ));
    }
    let type_name = first_child_type.unwrap_or_default();
    if !type_name.contains("WebKit") {
        return Err(format!(
            "主窗口结构不符合预期：内容区子项是 {type_name}，不是主 webview，内嵌浏览器暂不可用"
        ));
    }
    Ok(())
}

/// 逻辑像素矩形 → GTK 的整数坐标。负值与 NaN 已在 [`sanitize_rect`] 里处理过，
/// 这里只兜住超出 i32 的极端值。
fn rect_to_gtk(rect: (f64, f64, f64, f64)) -> (i32, i32, i32, i32) {
    let to_i32 = |value: f64| value.round().clamp(0.0, i32::MAX as f64) as i32;
    (
        to_i32(rect.0),
        to_i32(rect.1),
        to_i32(rect.2),
        to_i32(rect.3),
    )
}

/// 取已装好的 Fixed（没装过说明 webview 也不存在）。
fn current_fixed(state: &BrowserState) -> Result<gtk::Fixed, String> {
    state
        .linux
        .fixed
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .map(|fixed| fixed.0.clone())
        .ok_or_else(|| "内嵌浏览器的容器尚未初始化".to_string())
}

/// 把主窗口内容区改造成「主 webview 在下、Fixed 在上」的 Overlay 结构（幂等）。
/// 只能在主线程调。
fn ensure_fixed(window: &tauri::Window, state: &BrowserState) -> Result<gtk::Fixed, String> {
    {
        let installed = state
            .linux
            .fixed
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(fixed) = installed.as_ref() {
            return Ok(fixed.0.clone());
        }
    }

    let vbox = window
        .default_vbox()
        .map_err(|error| format!("取主窗口内容区失败: {error}"))?;
    let children = vbox.children();
    let first_type = children
        .first()
        .map(|child| child.type_().name().to_string());
    // 先校验再动布局：不满足就直接退出，一个 widget 都不碰。
    validate_vbox_layout(children.len(), first_type.as_deref())?;
    let main_webview = children
        .into_iter()
        .next()
        .ok_or_else(|| "主窗口内容区为空，内嵌浏览器暂不可用".to_string())?;

    let overlay = gtk::Overlay::new();
    vbox.remove(&main_webview);
    vbox.pack_start(&overlay, true, true, 0);
    // base child：由 Overlay 正常铺满 —— 与窗口尺寸天然联动，不需要我们跟 resize，
    // 也不会给它留下 size request（那会变成窗口的最小尺寸，窗口就再也缩不小）。
    overlay.add(&main_webview);
    // overlay child：同样铺满，但排在 base 之上。浏览器 webview 的坐标系就是它。
    let fixed = gtk::Fixed::new();
    overlay.add_overlay(&fixed);
    overlay.show_all();

    *state
        .linux
        .fixed
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some(SendFixed(fixed.clone()));
    Ok(fixed)
}

/// 槽位同步：把浏览器 webview 摆到给定矩形。
///
/// **不能只调 `wry::WebView::set_bounds`**：Fixed 父容器下它只做一次 `size_allocate`，
/// 不更新 GtkFixed 记着的 child 坐标与尺寸请求，窗口一重排就被旧值覆盖回去。
/// 这里直接维护 Fixed 的 child 属性（`move_` + `set_size_request`），GTK 每次重排都会用它们。
fn apply_bounds(fixed: &gtk::Fixed, webview: &wry::WebView, rect: (f64, f64, f64, f64)) {
    let (x, y, width, height) = rect_to_gtk(rect);
    let widget = webview.webview();
    fixed.move_(&widget, x, y);
    widget.set_size_request(width, height);
}

/// 构造浏览器 webview 并挂进 Fixed（只在首次 `browser_open` 时走一次）。
fn build_browser(
    app: &AppHandle,
    fixed: &gtk::Fixed,
    url: &Url,
    data_dir: PathBuf,
    state: &BrowserState,
    rect: (f64, f64, f64, f64),
) -> Result<wry::WebView, String> {
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("创建浏览器数据目录失败: {error}"))?;
    // 专用数据目录 + 非隐身：登录态跨重启保留，且与主 webview 的存储隔离。
    // 上下文对象交给 WebKitWebView 持有（GTK 引用计数），这个 wrapper 出了函数作用域没关系。
    let mut context = wry::WebContext::new(Some(data_dir));

    let (history, title, current_url) = (
        Arc::clone(&state.history),
        Arc::clone(&state.title),
        Arc::clone(&state.linux.current_url),
    );
    *current_url.lock().unwrap_or_else(PoisonError::into_inner) = url.as_str().to_string();

    let nav_history = Arc::clone(&history);
    let title_emitter = app.clone();
    let title_for_event = Arc::clone(&title);
    let title_history = Arc::clone(&history);
    let title_url = Arc::clone(&current_url);
    let load_emitter = app.clone();
    let load_history = Arc::clone(&history);
    let load_title = Arc::clone(&title);
    let load_url = Arc::clone(&current_url);
    let (x, y, width, height) = rect_to_gtk(rect);

    wry::WebViewBuilder::new_with_web_context(&mut context)
        .with_url(url.as_str())
        // 初始位置也带上：Fixed 的 `put` 用它，避免先以默认尺寸闪一下。
        .with_bounds(wry::Rect {
            position: wry::dpi::LogicalPosition::new(x, y).into(),
            size: wry::dpi::LogicalSize::new(width, height).into(),
        })
        .with_incognito(false)
        // 缩放会让「DOM 给的逻辑坐标」与页面视觉错位，读起来像 bug。
        .with_hotkeys_zoom(false)
        .with_focused(false)
        .with_navigation_handler(move |raw| {
            let Ok(parsed) = Url::parse(&raw) else {
                return false;
            };
            if !allowed_scheme(&parsed) {
                return false;
            }
            nav_history
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(parsed.as_str());
            true
        })
        .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
        .with_download_started_handler(|_, _| false)
        .with_permission_handler(|_| PermissionResponse::Deny)
        .with_document_title_changed_handler(move |new_title| {
            *title_for_event
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = new_title;
            let url = title_url
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            emit_state_payload(&title_emitter, &title_history, &title_for_event, url, false);
        })
        .with_on_page_load_handler(move |event, raw| {
            let loading = matches!(event, PageLoadEvent::Started);
            *load_url.lock().unwrap_or_else(PoisonError::into_inner) = raw.clone();
            emit_state_payload(&load_emitter, &load_history, &load_title, raw, loading);
        })
        .build_gtk(fixed)
        .map_err(|error| format!("创建内嵌浏览器失败: {error}"))
}

/// 打开（或复用）内嵌浏览器并定位到给定矩形。
pub async fn open(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let rect = sanitize_rect(x, y, width, height);
    let parsed = parse_navigable(&url)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("解析应用数据目录失败: {error}"))?
        .join("browser-profile");

    on_main(&app, move |app| {
        let state = app.state::<BrowserState>();
        {
            let installed = state
                .linux
                .webview
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if let Some(webview) = installed.as_ref() {
                // 复用：导航 + 重新对齐 + 显示。会话 / 滚动 / 表单状态因此得以保留。
                webview
                    .0
                    .load_url(parsed.as_str())
                    .map_err(|error| error.to_string())?;
                let fixed = current_fixed(&state)?;
                apply_bounds(&fixed, &webview.0, rect);
                webview
                    .0
                    .set_visible(true)
                    .map_err(|error| error.to_string())?;
                state.set_visible(true);
                return Ok(());
            }
        }

        let window = app
            .get_window(MAIN_WINDOW)
            .ok_or_else(|| "主窗口不存在".to_string())?;
        let fixed = ensure_fixed(&window, &state)?;
        let webview = build_browser(app, &fixed, &parsed, data_dir, &state, rect)?;
        apply_bounds(&fixed, &webview, rect);
        webview
            .set_visible(true)
            .map_err(|error| error.to_string())?;
        *state
            .linux
            .webview
            .lock()
            .unwrap_or_else(PoisonError::into_inner) =
            Some(SendWebView(ManuallyDrop::new(webview)));
        state.set_visible(true);
        Ok(())
    })
}

/// 把子 webview 对齐到渲染端给的槽位矩形（逻辑像素，窗口客户区坐标系）。
pub async fn set_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let rect = sanitize_rect(x, y, width, height);
    on_main(&app, move |app| {
        let state = app.state::<BrowserState>();
        let installed = state
            .linux
            .webview
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let Some(webview) = installed.as_ref() else {
            return Ok(());
        };
        apply_bounds(&current_fixed(&state)?, &webview.0, rect);
        Ok(())
    })
}

/// 显示 / 隐藏子 webview。隐藏后 GTK 不再合成它，弹层 / 折叠面板才能露出来。
pub async fn set_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    on_main(&app, move |app| {
        let state = app.state::<BrowserState>();
        if state.is_visible() == visible {
            return Ok(());
        }
        let installed = state
            .linux
            .webview
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let Some(webview) = installed.as_ref() else {
            return Ok(());
        };
        webview
            .0
            .set_visible(visible)
            .map_err(|error| error.to_string())?;
        state.set_visible(visible);
        Ok(())
    })
}

/// 导航到新地址（复用同一个子 webview，保留会话）。
pub async fn navigate(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = parse_navigable(&url)?;
    on_main(&app, move |app| {
        with_webview(app, |webview| {
            webview
                .load_url(parsed.as_str())
                .map_err(|error| error.to_string())
        })
    })
}

/// 后退。wry 没有 `go_back`，只能借页面自己的 `history`；导航栈由
/// `with_navigation_handler` 自校正，页面加载后再由 on_page_load 回推状态。
pub async fn back(app: AppHandle) -> Result<(), String> {
    on_main(&app, |app| {
        with_webview(app, |webview| {
            webview
                .evaluate_script("window.history.back()")
                .map_err(|error| error.to_string())
        })
    })
}

/// 前进。同 [`back`] 的取舍。
pub async fn forward(app: AppHandle) -> Result<(), String> {
    on_main(&app, |app| {
        with_webview(app, |webview| {
            webview
                .evaluate_script("window.history.forward()")
                .map_err(|error| error.to_string())
        })
    })
}

pub async fn reload(app: AppHandle) -> Result<(), String> {
    on_main(&app, |app| {
        with_webview(app, |webview| {
            webview.reload().map_err(|error| error.to_string())
        })
    })
}

/// 停止加载（wry 没有 stop，用 `window.stop()`）。
pub async fn stop(app: AppHandle) -> Result<(), String> {
    on_main(&app, |app| {
        with_webview(app, |webview| {
            webview
                .evaluate_script("window.stop()")
                .map_err(|error| error.to_string())
        })
    })
}

/// 销毁子 webview 并清空状态。容器 Fixed 留着复用（下次开浏览器不必再改布局）。
pub async fn close(app: AppHandle) -> Result<(), String> {
    on_main(&app, |app| {
        let state = app.state::<BrowserState>();
        let taken = state
            .linux
            .webview
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(mut webview) = taken {
            // 显式在主线程 drop：wry 的 `InnerWebView::drop` 会 destroy 掉 GTK widget。
            // （回调里只捕获了 Arc 数据与 AppHandle，没人持有 widget，故不会留悬垂引用。）
            unsafe { ManuallyDrop::drop(&mut webview.0) };
        }
        state
            .linux
            .current_url
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
        state.reset();
        Ok(())
    })
}

/// 「取现有 webview → 执行 → 没有就静默跳过」的公共骨架（与 Tauri 路径的早退语义一致）。
fn with_webview<F>(app: &AppHandle, run: F) -> Result<(), String>
where
    F: FnOnce(&wry::WebView) -> Result<(), String>,
{
    let state = app.state::<BrowserState>();
    let installed = state
        .linux
        .webview
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    match installed.as_ref() {
        Some(webview) => run(&webview.0),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_vbox_accepts_single_webview_child() {
        assert!(validate_vbox_layout(1, Some("WebKitWebView")).is_ok());
    }

    #[test]
    fn validate_vbox_rejects_menu_bar_or_missing_child() {
        // 菜单栏会作为第二个子项出现在同一个 vbox 里 —— 那时不能搬动主 webview。
        assert!(validate_vbox_layout(2, Some("WebKitWebView")).is_err());
        assert!(validate_vbox_layout(0, None).is_err());
    }

    #[test]
    fn validate_vbox_rejects_non_webview_child() {
        assert!(validate_vbox_layout(1, Some("GtkBox")).is_err());
        assert!(validate_vbox_layout(1, None).is_err());
    }

    #[test]
    fn rect_to_gtk_rounds_and_clamps() {
        assert_eq!(rect_to_gtk((10.4, 20.6, 300.5, 150.2)), (10, 21, 301, 150));
        assert_eq!(rect_to_gtk((0.0, 0.0, 0.0, 0.0)), (0, 0, 0, 0));
        assert_eq!(rect_to_gtk((-5.0, -0.4, 100.0, 50.0)), (0, 0, 100, 50));
        assert_eq!(rect_to_gtk((f64::MAX, 0.0, 1.0, 1.0)), (i32::MAX, 0, 1, 1));
    }
}
