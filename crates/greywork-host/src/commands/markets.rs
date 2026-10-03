//! MCP / skills / 插件市场命令
//!
//! 本域的命令**行宏**：把该域的命令行追加到 `command_table` 的累积列表里。
//! 顺序由 `commands/registry.rs` 的入口链唯一决定（此处不决定前后）。

macro_rules! markets_commands {
    ([$next:ident $($rest:ident)*] $($acc:tt)*) => {
        $next! { [$($rest)*] $($acc)*
    // ---- mcp ----
    { "mcp_probe", auth: Auth::Required, desktop: false, binary: false,
        args: mcp::ProbeArgs,
        run: |_ctx, a| async move { mcp::mcp_probe(a.transport, a.url, a.command, a.args, a.env, a.headers, a.timeout_secs).await.map(Json) } }

    // ---- skills_market ----
    { "skills_search", auth: Auth::Required, desktop: false, binary: false,
        args: skills_market::SearchArgs,
        run: |_ctx, a| async move { skills_market::skills_search(a.origin, a.query).await.map(Json) } }
    { "skills_download", auth: Auth::Required, desktop: false, binary: false,
        args: skills_market::DownloadArgs,
        run: |_ctx, a| async move { skills_market::skills_download(a.origin, a.entry_ref).await.map(Json) } }
    { "skills_install", auth: Auth::Required, desktop: false, binary: false,
        args: skills_market::InstallArgs,
        run: |_ctx, a| async move { skills_market::skills_install(a.workspace_root, a.skill_id, a.files).await.map(Json) } }
    { "skills_uninstall", auth: Auth::Required, desktop: false, binary: false,
        args: skills_market::UninstallArgs,
        run: |_ctx, a| async move { skills_market::skills_uninstall(a.workspace_root, a.skill_id).await.map(Json) } }
    // 内置技能（内容编译进二进制，不联网）：列出 + 安装。
    { "skills_bundled_list", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |_ctx, _a| async move { Ok::<_, String>(Json(bundled_skills::skills_bundled_list())) } }
    { "skills_install_bundled", auth: Auth::Required, desktop: false, binary: false,
        args: bundled_skills::InstallBundledArgs,
        run: |_ctx, a| async move { bundled_skills::skills_install_bundled(a.workspace_root, a.skill_id).map(Json) } }

    // ---- plugin_market ----
    { "plugin_market_catalog", auth: Auth::Required, desktop: false, binary: false,
        args: plugin_market::CatalogArgs,
        run: |_ctx, a| async move { plugin_market::plugin_market_catalog(a.registry_url).await.map(Json) } }
    { "plugin_market_install", auth: Auth::Required, desktop: false, binary: false,
        args: plugin_market::InstallArgs,
        run: |ctx, a| async move { plugin_market::plugin_market_install(ctx.host.as_ref(), a.registry_url, a.plugin_id).await.map(Json) } }
    { "plugin_market_list_installed", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { Ok::<_, String>(Json(plugin_market::plugin_market_list_installed(ctx.host.as_ref()))) } }
    { "plugin_market_uninstall", auth: Auth::Required, desktop: false, binary: false,
        args: plugin_market::UninstallArgs,
        run: |ctx, a| async move { plugin_market::plugin_market_uninstall(ctx.host.as_ref(), a.plugin_id).map(Json) } }
    { "plugin_net_fetch", auth: Auth::Required, desktop: false, binary: false,
        args: plugin_market::PluginFetchRequest,
        run: |_ctx, a| async move { plugin_market::plugin_net_fetch(a).await.map(Json) } }
    { "plugin_market_preview", auth: Auth::Required, desktop: false, binary: false,
        args: plugin_market::PreviewArgs,
        run: |_ctx, a| async move { plugin_market::plugin_market_preview(a.registry_url, a.plugin_id).await.map(Json) } }

    // ---- plugin_window（桌面专属） ----
    { "plugin_window_open", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }
    { "plugin_window_close", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }

    // ---- mcp_registry ----
    { "mcp_search", auth: Auth::Required, desktop: false, binary: false,
        args: mcp_registry::SearchArgs,
        run: |_ctx, a| async move { mcp_registry::mcp_search(a.search, a.limit).await.map(Json) } }

    // ---- web_fetch ----
    { "web_fetch", auth: Auth::Required, desktop: false, binary: false,
        args: web_fetch::WebFetchRequest,
        run: |_ctx, a| async move { web_fetch::web_fetch(a).await.map(Json) } }

        }
    };
}
pub(crate) use markets_commands;
