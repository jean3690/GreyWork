mod acp_host;
mod llm;
pub mod mcp_client;
mod mcp_registry;
mod process_guard;
mod skills_market;
mod web_search;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(acp_host::AcpHost::default())
        .manage(llm::LlmHost::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            acp_host::acp_permission_respond,
            acp_host::acp_start,
            acp_host::acp_new_session,
            acp_host::acp_send,
            acp_host::acp_set_config,
            acp_host::acp_stop,
            acp_host::acp_list,
            llm::llm_chat_start,
            llm::llm_chat_stop,
            web_search::web_search,
            skills_market::skills_search,
            skills_market::skills_download,
            skills_market::skills_install,
            skills_market::skills_uninstall,
            mcp_registry::mcp_search,
            mcp_client::mcp_probe_stdio,
            mcp_client::mcp_probe_remote,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
