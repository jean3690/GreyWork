mod acp_host;
mod db;
mod host_exec;
mod http;
mod llm;
mod log;
pub mod mcp;
mod mcp_registry;
mod notify;
mod plugin_market;
mod plugin_window;
mod process_guard;
mod sandbox;
mod scheduler;
mod skills_market;
mod store_fs;
mod sys;
mod web_fetch;
mod workspace_fs;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(acp_host::AcpHost::default())
        .manage(llm::LlmHost::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if let Some(access) = window.try_state::<workspace_fs::WorkspaceFsAccess>() {
                    if let Err(error) = access.authorize_drop_paths(paths) {
                        log::warn("workspace_fs", format!("拖放路径授权失败: {error}"));
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
            let database = db::Db::open_at(&data_dir.join("greywork.db"))
                .map_err(|err| -> Box<dyn std::error::Error> { err.into() })?;
            app.manage(database);
            scheduler::spawn_ticker(app.handle().clone(), data_dir.join("greywork.db"));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sys::sys_info,
            sys::reveal_path,
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
            workspace_fs::fs_read_text_file,
            workspace_fs::fs_read_binary,
            workspace_fs::fs_write_text_file,
            workspace_fs::fs_write_binary,
            workspace_fs::fs_ensure_dir,
            workspace_fs::fs_list_dir,
            workspace_fs::fs_pick_files,
            store_fs::store_sessions_load,
            store_fs::store_sessions_sync,
            store_fs::store_default_root,
            store_fs::attachments_prune_session,
            store_fs::store_sessions_relocate,
            store_fs::pick_workspace_folder,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
