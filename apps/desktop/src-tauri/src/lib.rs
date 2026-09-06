mod acp_host;
mod db;
mod host_exec;
mod http;
mod llm;
mod log;
pub mod mcp;
mod process_guard;
mod sandbox;
mod scheduler;
mod store_fs;
mod sys;
mod web_search;
mod workspace_fs;

use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(acp_host::AcpHost::default())
        .manage(llm::LlmHost::default())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            log::init(data_dir.join("logs"));
            let database = db::Db::open_at(&data_dir.join("greywork.db"))
                .map_err(|err| -> Box<dyn std::error::Error> { err.into() })?;
            app.manage(database);
            scheduler::spawn_ticker(app.handle().clone(), data_dir.join("greywork.db"));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            sys::sys_info,
            sys::reveal_path,
            acp_host::acp_permission_respond,
            acp_host::acp_start,
            acp_host::acp_new_session,
            acp_host::acp_send,
            acp_host::acp_set_config,
            acp_host::acp_stop,
            acp_host::acp_set_permission_tier,
            acp_host::acp_list,
            acp_host::acp_detect_programs,
            llm::llm_chat_start,
            llm::llm_chat_stop,
            mcp::mcp_probe,
            web_search::web_search,
            workspace_fs::fs_read_text_file,
            workspace_fs::fs_read_binary,
            workspace_fs::fs_write_text_file,
            workspace_fs::fs_write_binary,
            workspace_fs::fs_ensure_dir,
            workspace_fs::fs_list_dir,
            store_fs::store_sessions_load,
            store_fs::store_sessions_sync,
            store_fs::store_default_root,
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
