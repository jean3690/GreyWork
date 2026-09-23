mod acp_host;
mod acp_process;
mod channel_common;
mod channel_media;
mod close_guard;
mod cron;
mod db;
pub mod dingtalk;
pub mod discord;
pub mod feishu;
mod git;
mod host_exec;
mod http;
mod llm;
mod log;
pub mod mcp;
mod mcp_registry;
mod notify;
mod path_safety;
mod plugin_market;
mod plugin_window;
mod process_guard;
pub mod qq;
mod sandbox;
mod scheduler;
mod sheet;
mod skills_market;
mod store_fs;
mod sys;
pub mod telegram;
mod text;
mod tray;
mod update;
mod web_fetch;
pub mod wechat;
pub mod wecom;
mod workspace_fs;
mod worktree;

use tauri::Manager;

/// Linux 低端设备的 WebKitGTK 渲染兜底：关掉 DMABUF 渲染器。
///
/// webkit2gtk 的 DMABUF 渲染路径在低显存 / 老驱动的机器上会渲染出黑块、花屏，甚至整窗空白
/// 或直接崩掉 —— 低内存设备上尤其常见。退回共享内存渲染（`WEBKIT_DISABLE_DMABUF_RENDERER=1`）
/// 代价是合成性能略降，但换来能正常显示，这是"WebView 渲染崩溃"最直接的宿主侧处置：
/// 渲染端再怎么优化 JS/CSS 都到不了这一层。
///
/// **必须在建窗口之前设置**：该变量只在 webkit 初始化时读一次，晚于 Builder 就无效。
///
/// 只在用户**没有显式设置**时兜底 —— 显式设置代表用户/发行版封装脚本已经知道自己在做什么，
/// 不该被覆盖；这也是自动判定万一误伤正常机器时唯一的逃生口（自行设成 0 即可关掉）。
#[cfg(target_os = "linux")]
fn apply_low_end_webkit_fallback() {
    if !sys::is_low_end_device() {
        return;
    }
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        // 这里用 eprintln 而非 crate::log：日志目录在 setup 里才 init，而本函数必须在建窗口
        // 之前跑，此刻 log 还是 no-op，写了也会被丢掉（同 log.rs 处理自身轮转失败的取舍）。
        eprintln!(
            "[greywork] 低端设备：已关闭 DMABUF 渲染器（WEBKIT_DISABLE_DMABUF_RENDERER=1）以规避渲染异常"
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    apply_low_end_webkit_fallback();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(acp_host::AcpHost::default())
        .manage(llm::LlmHost::default())
        .manage(wechat::WechatHost::default())
        .manage(dingtalk::DingTalkHost::default())
        .manage(feishu::FeishuHost::default())
        .manage(telegram::TelegramHost::default())
        .manage(discord::DiscordHost::default())
        .manage(qq::QqHost::default())
        .manage(wecom::WecomHost::default())
        .manage(tray::TrayState::default())
        .manage(close_guard::CloseGuard::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if let Some(access) = window.try_state::<workspace_fs::WorkspaceFsAccess>() {
                    if let Err(error) = access.authorize_drop_paths(paths) {
                        log::warn("workspace_fs", format!("拖放路径授权失败: {error}"));
                    }
                }
            }
            // 关闭到托盘：只拦主窗口。偏好由渲染端经 set_close_to_tray 同步（它是设置
            // 快照的一部分），但**托盘真的建出来了**才是前提 —— should_hide_on_close
            // 把这两条一起判了。没有托盘还拦下关闭，窗口会消失且无入口恢复。
            // 托盘「退出应用」走 app.exit，不经过这里。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == tray::MAIN_WINDOW {
                    if let Some(state) = window.try_state::<tray::TrayState>() {
                        if state.should_hide_on_close() {
                            api.prevent_close();
                            let _ = window.hide();
                            // 窗口藏起来后托盘是唯一入口，第一次要说一声。
                            tray::notify_hidden(window.app_handle(), &state);
                        }
                    }
                }
            }
        })
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let home_dir = app.path().home_dir()?;
            let default_root = store_fs::default_root(&home_dir)
                .map_err(|err| -> Box<dyn std::error::Error> { err.into() })?;
            let workspace_access = workspace_fs::WorkspaceFsAccess::new(
                &default_root,
                data_dir.join("workspace-path-access.json"),
            )
            .map_err(|err| -> Box<dyn std::error::Error> { err.into() })?;
            app.manage(workspace_access);
            log::init(data_dir.join("logs"));
            // GUI 启动（Finder/Dock、.desktop）继承的 PATH 是极简的，这里补一次登录
            // shell 解析，供程序探测与子进程注入使用。后台线程跑，失败即退回继承 PATH。
            process_guard::init_login_path();
            let database = db::Db::open_at(&data_dir.join("greywork.db"))
                .map_err(|err| -> Box<dyn std::error::Error> { err.into() })?;
            app.manage(database);
            scheduler::spawn_ticker(app.handle().clone(), data_dir.join("greywork.db"));
            // 系统托盘：构建失败不该拦启动（例如 Linux 缺 AppIndicator 宿主），
            // 记一条日志后继续 —— 没有托盘，其余功能照常。失败时 TrayState.available
            // 保持 false，关闭行为随之回落到「关闭即退出」，不会把用户锁在隐藏窗口里。
            if let Err(error) = tray::init(app) {
                log::warn(
                    "tray",
                    format!("系统托盘初始化失败，本次不提供托盘: {error}"),
                );
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sys::sys_info,
            sys::reveal_path,
            sys::open_path,
            close_guard::set_unsaved_changes,
            close_guard::confirm_exit,
            acp_host::acp_permission_respond,
            acp_host::acp_start,
            acp_host::acp_new_session,
            acp_host::acp_load_session,
            acp_host::acp_send,
            acp_host::acp_set_config,
            acp_host::acp_stop,
            acp_host::acp_set_permission_tier,
            acp_host::acp_list,
            acp_host::acp_detect_programs,
            llm::llm_chat_start,
            llm::llm_chat_stop,
            mcp::mcp_probe,
            skills_market::skills_search,
            skills_market::skills_download,
            skills_market::skills_install,
            skills_market::skills_uninstall,
            plugin_market::plugin_market_catalog,
            plugin_market::plugin_market_install,
            plugin_market::plugin_market_list_installed,
            plugin_market::plugin_market_uninstall,
            plugin_market::plugin_net_fetch,
            plugin_window::plugin_window_open,
            plugin_window::plugin_window_close,
            plugin_market::plugin_market_preview,
            mcp_registry::mcp_search,
            web_fetch::web_fetch,
            wechat::wechat_status,
            wechat::wechat_login_qr,
            wechat::wechat_login_poll,
            wechat::wechat_login_cancel,
            wechat::wechat_connect,
            wechat::wechat_disconnect,
            wechat::wechat_logout,
            wechat::wechat_send,
            wechat::wechat_send_typing,
            channel_media::channel_take_media,
            channel_media::channel_send_media,
            channel_media::channel_media_capabilities,
            dingtalk::dingtalk_status,
            dingtalk::dingtalk_save_credentials,
            dingtalk::dingtalk_clear_credentials,
            dingtalk::dingtalk_register_begin,
            dingtalk::dingtalk_register_poll,
            dingtalk::dingtalk_register_cancel,
            dingtalk::dingtalk_connect,
            dingtalk::dingtalk_disconnect,
            dingtalk::dingtalk_send,
            feishu::feishu_status,
            feishu::feishu_save_credentials,
            feishu::feishu_clear_credentials,
            feishu::feishu_register_begin,
            feishu::feishu_register_poll,
            feishu::feishu_register_cancel,
            feishu::feishu_connect,
            feishu::feishu_disconnect,
            feishu::feishu_send,
            telegram::telegram_status,
            telegram::telegram_save_credentials,
            telegram::telegram_clear_credentials,
            telegram::telegram_connect,
            telegram::telegram_disconnect,
            telegram::telegram_send,
            telegram::telegram_bot_link,
            discord::discord_status,
            discord::discord_save_credentials,
            discord::discord_clear_credentials,
            discord::discord_connect,
            discord::discord_disconnect,
            discord::discord_send,
            qq::qq_status,
            qq::qq_save_credentials,
            qq::qq_register_begin,
            qq::qq_register_poll,
            qq::qq_register_cancel,
            qq::qq_clear_credentials,
            qq::qq_connect,
            qq::qq_disconnect,
            qq::qq_send,
            wecom::wecom_status,
            wecom::wecom_save_credentials,
            wecom::wecom_clear_credentials,
            wecom::wecom_connect,
            wecom::wecom_disconnect,
            wecom::wecom_send,
            workspace_fs::fs_read_text_file,
            workspace_fs::fs_read_binary,
            sheet::fs_read_sheet,
            workspace_fs::fs_write_text_file,
            workspace_fs::fs_write_binary,
            workspace_fs::fs_ensure_dir,
            workspace_fs::fs_list_dir,
            workspace_fs::fs_pick_files,
            git::git_status,
            git::git_changes,
            git::git_diff,
            git::git_commit,
            git::git_current_branch,
            git::git_branch_list,
            store_fs::store_sessions_load,
            store_fs::store_sessions_sync,
            store_fs::store_default_root,
            store_fs::attachments_prune_session,
            store_fs::store_sessions_relocate,
            store_fs::pick_workspace_folder,
            worktree::worktree_provision,
            worktree::worktree_release,
            worktree::worktree_list,
            db::db_settings_load,
            db::db_settings_sync,
            db::db_automations_load,
            db::db_automations_sync,
            db::db_automations_due_list,
            db::db_automations_due_finish,
            db::db_team_runs_load,
            db::db_team_runs_sync,
            db::db_agents_load,
            db::db_agents_sync,
            tray::set_close_to_tray,
            tray::set_tray_labels,
            update::check_update,
            update::open_external,
        ])
        // 走 build + App::run(callback) 而不是 Builder::run(context)：只有后者能拿到
        // 事件循环回调，macOS 的 Reopen 需要它。
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(on_run_event);
}

/// 事件循环回调：macOS 的 Reopen + 有未保存改动时的退出拦截。
///
/// 窗口被「关闭到托盘」藏起来之后，Dock 图标还在 —— 点 Dock 是 macOS 用户最直觉的
/// 恢复方式，不处理的话点了没反应，只能绕去菜单栏托盘图标。`RunEvent::Reopen` 这个
/// 变体本身是 `#[cfg(target_os = "macos")]`，所以整块按平台编译。
///
/// `ExitRequested` 兜的是渲染端够不着的那两条退出路径：托盘菜单「退出应用」与
/// macOS 的 Cmd+Q（`app.exit` 绕过 CloseRequested，见 close_guard.rs 顶部）。
/// 拦下后发事件给渲染端，由它先保存、再调 `confirm_exit` 真正退出。
fn on_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Reopen { .. } = event {
        tray::show_main(app);
    }
    if let tauri::RunEvent::ExitRequested { api, .. } = event {
        if close_guard::handle_exit_requested(app) {
            api.prevent_exit();
        }
    }
}
