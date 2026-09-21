//! 系统托盘 + 「关闭到托盘」策略。
//!
//! 托盘在 Rust 侧构建（不走渲染端的 `core:tray:*` 命令），所以 capabilities 不需要
//! 任何 tray 权限；前端只订阅两个事件（`tray:new-chat` / `tray:open-settings`），
//! 走的是 core:default 里已有的 event 权限。
//!
//! 两个偏好 / 文案都由渲染端持有并同步过来（它们随 settings 快照一起持久化，宿主侧
//! 不该有第二份真相）：
//! - `set_close_to_tray`：「关闭到托盘」开关，决定 CloseRequested 拦不拦。
//! - `set_tray_labels`：菜单文案 + 首次隐藏的提示语，语言切换时重发。
//!
//! **可用性钳制**：托盘构建可能失败（Linux 缺 AppIndicator 宿主是最常见的一种），
//! 此时 [`TrayState::should_hide_on_close`] 恒为 false —— 没有托盘还把窗口藏起来，
//! 用户就再也找不到入口了。这条钳制不看偏好值，是硬约束。
//!
//! 平台差异：
//! - Linux：`TrayIconEvent::Click` 不派发（tauri 明确标注不支持），左键单击切显隐只在
//!   Windows / macOS 生效；Linux 走菜单里的「显示/隐藏主窗口」。另外需要
//!   AppIndicator 宿主（libayatana-appindicator / libappindicator）。
//! - macOS：图标用模板图（随明暗菜单栏自动反色）；隐藏窗口后 Dock 图标仍在，
//!   点 Dock 恢复走 lib.rs 里的 `RunEvent::Reopen`。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// 主窗口 label（tauri.conf.json 的 windows[] 未显式声明 label，默认 "main"）。
/// lib.rs 的 CloseRequested 拦截与 `show_main` 都用它，不要再写字符串字面量。
pub const MAIN_WINDOW: &str = "main";

/// 托盘 id：`tray_by_id` / `remove_tray_by_id` 用。
const TRAY_ID: &str = "main-tray";

/// 通知标题（产品名，不进 i18n）。
const APP_NAME: &str = "GreyWork";

const MENU_TOGGLE: &str = "tray.toggle-window";
const MENU_NEW_CHAT: &str = "tray.new-chat";
const MENU_SETTINGS: &str = "tray.settings";
const MENU_QUIT: &str = "tray.quit";

/// 渲染端订阅的事件名（`tray-bridge.ts` 里同名）。
pub const EVENT_NEW_CHAT: &str = "tray:new-chat";
pub const EVENT_OPEN_SETTINGS: &str = "tray:open-settings";

/// 菜单构建时的占位文案。
///
/// 菜单必须在 setup 里就绪（早于 webview 加载），拿不到渲染端的语言；这几条只是
/// 「渲染端推文案之前」的短暂占位，默认跟随应用默认语言 zh-CN。渲染端挂载后立刻
/// 调 `set_tray_labels` 覆盖，之后切语言也会重推。
const PLACEHOLDER_TOGGLE: &str = "显示/隐藏主窗口";
const PLACEHOLDER_NEW_CHAT: &str = "新建对话";
const PLACEHOLDER_SETTINGS: &str = "打开设置";
const PLACEHOLDER_QUIT: &str = "退出应用";

/// 渲染端推来的托盘文案。字段用 camelCase，与 `lib/tray-bridge.ts` 的 TrayLabels 对齐。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayLabels {
    pub toggle_window: String,
    pub new_chat: String,
    pub settings: String,
    pub quit: String,
    /// 「已最小化到托盘」的提示正文；缺省 / 空串则不发系统通知。
    #[serde(default)]
    pub hidden_hint: Option<String>,
}

/// 菜单条目句柄：`set_tray_labels` 靠它改运行期文案。
struct MenuHandles {
    toggle: MenuItem<Wry>,
    new_chat: MenuItem<Wry>,
    settings: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

/// 需要加锁的托盘内部状态（原子量之外的部分）。
#[derive(Default)]
struct TrayInner {
    /// 菜单句柄；init 成功后才填充，失败则一直是 None。
    menu: Option<MenuHandles>,
    /// 渲染端推来的文案；未推之前为 None。
    labels: Option<TrayLabels>,
}

/// 托盘运行时状态。
pub struct TrayState {
    /// 托盘图标是否真的建出来了。**唯一的可用性真相**，init 成功才置位。
    available: AtomicBool,
    /// 渲染端同步来的「关闭到托盘」偏好（未做可用性钳制）。
    close_to_tray: AtomicBool,
    /// 菜单句柄 + 文案。
    inner: Mutex<TrayInner>,
    /// 首次隐藏提示是否已发（每进程只发一次，避免每次关窗都弹）。
    hint_sent: AtomicBool,
}

impl Default for TrayState {
    fn default() -> Self {
        Self {
            // 默认不可用：只有 init 真的建成托盘才置 true。
            available: AtomicBool::new(false),
            // 与前端 SavedSettings 的默认值一致（默认关闭到托盘）。
            close_to_tray: AtomicBool::new(true),
            inner: Mutex::new(TrayInner::default()),
            hint_sent: AtomicBool::new(false),
        }
    }
}

impl TrayState {
    /// 托盘是否可用（sys_info 回给设置页，决定「关闭到托盘」能不能选）。
    pub fn available(&self) -> bool {
        self.available.load(Ordering::Relaxed)
    }

    /// 宿主拦截 CloseRequested 的依据：偏好为真 **且** 托盘真的存在。
    ///
    /// 可用性这条是硬钳制：没有托盘还拦下关闭，窗口会消失且无任何入口恢复。
    pub fn should_hide_on_close(&self) -> bool {
        self.available() && self.close_to_tray.load(Ordering::Relaxed)
    }

    /// 取「首次隐藏提示」的正文，并**只在真的取到时**标记已发。
    ///
    /// 文案还没推到时返回 None 且不置位 —— 启动瞬间就关窗不该白白用掉这一次提示。
    fn take_hidden_hint(&self) -> Option<String> {
        if self.hint_sent.load(Ordering::Relaxed) {
            return None;
        }
        let body = {
            let inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
            inner
                .labels
                .as_ref()
                .and_then(|labels| labels.hidden_hint.clone())
        };
        let body = body.filter(|text| !text.is_empty())?;
        self.hint_sent.store(true, Ordering::Relaxed);
        Some(body)
    }
}

/// 同步「关闭到托盘」偏好。
#[tauri::command]
pub fn set_close_to_tray(state: tauri::State<'_, TrayState>, enabled: bool) {
    state.close_to_tray.store(enabled, Ordering::Relaxed);
}

/// 同步托盘菜单文案（启动水合 + 每次切语言）。托盘不可用时静默接受，只存文案。
#[tauri::command]
pub fn set_tray_labels(
    state: tauri::State<'_, TrayState>,
    labels: TrayLabels,
) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(menu) = inner.menu.as_ref() {
        menu.toggle
            .set_text(&labels.toggle_window)
            .map_err(|e| e.to_string())?;
        menu.new_chat
            .set_text(&labels.new_chat)
            .map_err(|e| e.to_string())?;
        menu.settings
            .set_text(&labels.settings)
            .map_err(|e| e.to_string())?;
        menu.quit
            .set_text(&labels.quit)
            .map_err(|e| e.to_string())?;
    }
    inner.labels = Some(labels);
    Ok(())
}

/// 把主窗口从托盘里叫回来：显示 → 取消最小化 → 聚焦。
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 窗口刚被藏进托盘时提示一次。
///
/// 窗口一藏，托盘就是唯一入口 —— 不说一声用户会以为应用退出了。每次进程只提示一次
/// （`hint_sent`），且文案由渲染端给（宿主不持有语言）。通知失败只记日志（见 notify）。
pub fn notify_hidden(app: &AppHandle, state: &TrayState) {
    if let Some(body) = state.take_hidden_hint() {
        crate::notify::send(app, APP_NAME, &body);
    }
}

/// 显示/隐藏主窗口（菜单项与左键单击共用）。
fn toggle_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_main(app);
        }
    }
}

pub fn init(app: &tauri::App) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, MENU_TOGGLE, PLACEHOLDER_TOGGLE, true, None::<&str>)?;
    let new_chat = MenuItem::with_id(app, MENU_NEW_CHAT, PLACEHOLDER_NEW_CHAT, true, None::<&str>)?;
    let settings = MenuItem::with_id(app, MENU_SETTINGS, PLACEHOLDER_SETTINGS, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, PLACEHOLDER_QUIT, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle, &new_chat, &settings, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        // 悬停提示：产品名，不进 i18n。
        .tooltip(APP_NAME)
        // 左键留给「切换显隐」，右键出菜单（Linux 上左键事件不派发，只能走菜单项）。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_TOGGLE => toggle_main(app),
            MENU_NEW_CHAT => {
                show_main(app);
                let _ = app.emit(EVENT_NEW_CHAT, ());
            }
            MENU_SETTINGS => {
                show_main(app);
                let _ = app.emit(EVENT_OPEN_SETTINGS, ());
            }
            // app.exit 直接拆事件循环，绕过 CloseRequested —— 关闭到托盘开着也能真退出。
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    #[cfg(target_os = "macos")]
    {
        // 模板图：菜单栏明暗切换时由系统反色，不用自备两套图标。
        builder = builder.icon_as_template(true);
    }

    builder.build(app)?;

    // 建成之后才置可用 —— 失败时（? 提前返回）available 保持 false，关闭行为随之回落
    // 到「关闭即退出」，不会把用户锁在看不见的窗口里。
    let state = app.state::<TrayState>();
    state.available.store(true, Ordering::Relaxed);
    let mut inner = state.inner.lock().unwrap_or_else(PoisonError::into_inner);
    inner.menu = Some(MenuHandles {
        toggle,
        new_chat,
        settings,
        quit,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels() -> TrayLabels {
        TrayLabels {
            toggle_window: "Show/Hide".into(),
            new_chat: "New chat".into(),
            settings: "Settings".into(),
            quit: "Quit".into(),
            hidden_hint: Some("Still running".into()),
        }
    }

    #[test]
    fn close_to_tray_preference_defaults_to_enabled() {
        // 默认与前端 SavedSettings.closeToTray 的默认值必须一致，否则首启行为会随
        // 「前端水合早于/晚于首次关闭」而漂移。
        let state = TrayState::default();
        assert!(state.close_to_tray.load(Ordering::Relaxed));
    }

    #[test]
    fn no_tray_never_hides_on_close() {
        // 核心钳制：托盘不可用时，无论偏好怎么设都不能拦关闭 —— 否则窗口藏起来后
        // 没有任何入口能恢复。
        let state = TrayState::default();
        assert!(!state.available());
        assert!(!state.should_hide_on_close());

        state.close_to_tray.store(true, Ordering::Relaxed);
        assert!(!state.should_hide_on_close());
    }

    #[test]
    fn available_tray_follows_preference() {
        let state = TrayState::default();
        state.available.store(true, Ordering::Relaxed);

        assert!(state.should_hide_on_close());
        state.close_to_tray.store(false, Ordering::Relaxed);
        assert!(!state.should_hide_on_close());
    }

    #[test]
    fn hidden_hint_is_taken_at_most_once() {
        let state = TrayState::default();
        // 文案还没推到：不消耗这一次机会。
        assert!(state.take_hidden_hint().is_none());

        state.inner.lock().unwrap().labels = Some(labels());
        assert_eq!(state.take_hidden_hint().as_deref(), Some("Still running"));
        // 第二次不再返回 —— 每次进程只打扰一次。
        assert!(state.take_hidden_hint().is_none());
    }

    #[test]
    fn empty_hidden_hint_does_not_consume_the_slot() {
        let state = TrayState::default();
        let mut pushed = labels();
        pushed.hidden_hint = Some(String::new());
        state.inner.lock().unwrap().labels = Some(pushed);
        assert!(state.take_hidden_hint().is_none());
        assert!(!state.hint_sent.load(Ordering::Relaxed));
    }

    #[test]
    fn tray_labels_deserialize_from_camel_case() {
        // 契约：lib/tray-bridge.ts 发的是 camelCase。
        let json = r#"{
            "toggleWindow": "Show/Hide",
            "newChat": "New chat",
            "settings": "Settings",
            "quit": "Quit",
            "hiddenHint": "Still running"
        }"#;
        let parsed: TrayLabels = serde_json::from_str(json).expect("deserialize");
        assert_eq!(parsed.toggle_window, "Show/Hide");
        assert_eq!(parsed.hidden_hint.as_deref(), Some("Still running"));
    }

    #[test]
    fn tray_labels_hidden_hint_is_optional() {
        let json = r#"{
            "toggleWindow": "a", "newChat": "b", "settings": "c", "quit": "d"
        }"#;
        let parsed: TrayLabels = serde_json::from_str(json).expect("deserialize");
        assert!(parsed.hidden_hint.is_none());
    }

    #[test]
    fn menu_and_event_ids_are_stable() {
        // 这些字符串是托盘菜单与渲染端事件的契约（tray-bridge.ts 按同名事件订阅）。
        assert_eq!(MENU_TOGGLE, "tray.toggle-window");
        assert_eq!(MENU_NEW_CHAT, "tray.new-chat");
        assert_eq!(MENU_SETTINGS, "tray.settings");
        assert_eq!(MENU_QUIT, "tray.quit");
        assert_eq!(EVENT_NEW_CHAT, "tray:new-chat");
        assert_eq!(EVENT_OPEN_SETTINGS, "tray:open-settings");
        assert_eq!(MAIN_WINDOW, "main");
    }
}
