//! ACP agent 进程命令
//!
//! 本域的命令**行宏**：把该域的命令行追加到 `command_table` 的累积列表里。
//! 顺序由 `commands/registry.rs` 的入口链唯一决定（此处不决定前后）。

macro_rules! acp_commands {
    ([$next:ident $($rest:ident)*] $($acc:tt)*) => {
        $next! { [$($rest)*] $($acc)*
    // ---- acp_host ----
    { "acp_permission_respond", auth: Auth::Required, desktop: false, binary: false,
        args: acp_host::PermissionRespondArgs,
        run: |ctx, a| async move { acp_host::acp_permission_respond(&ctx.services.acp, a.request_id, a.option_id).await.map(Json) } }
    { "acp_start", auth: Auth::Required, desktop: false, binary: false,
        args: acp_host::StartArgs,
        run: |ctx, a| async move { acp_host::acp_start(Arc::clone(&ctx.host), &ctx.services.acp, &ctx.agent_programs, ctx.services.workspace.as_ref(), a.agent_cmd, a.tier, a.sandbox, a.workspace, a.env).await.map(Json) } }
    { "acp_new_session", auth: Auth::Required, desktop: false, binary: false,
        args: acp_host::NewSessionArgs,
        run: |ctx, a| async move { acp_host::acp_new_session(Arc::clone(&ctx.host), &ctx.services.acp, a.handle, a.cwd, a.mcp_servers).await.map(Json) } }
    { "acp_load_session", auth: Auth::Required, desktop: false, binary: false,
        args: acp_host::LoadSessionArgs,
        run: |ctx, a| async move { acp_host::acp_load_session(Arc::clone(&ctx.host), &ctx.services.acp, a.handle, a.cwd, a.session_id, a.mcp_servers).await.map(Json) } }
    { "acp_send", auth: Auth::Required, desktop: false, binary: false,
        args: acp_host::SendArgs,
        run: |ctx, a| async move { acp_host::acp_send(Arc::clone(&ctx.host), &ctx.services.acp, a.handle, a.text, a.units).await.map(Json) } }
    { "acp_set_config", auth: Auth::Required, desktop: false, binary: false,
        args: acp_host::SetConfigArgs,
        run: |ctx, a| async move { acp_host::acp_set_config(&ctx.services.acp, a.handle, a.config_id, a.value).await.map(Json) } }
    { "acp_stop", auth: Auth::Required, desktop: false, binary: false,
        args: acp_host::StopArgs,
        run: |ctx, a| async move { acp_host::acp_stop(Arc::clone(&ctx.host), &ctx.services.acp, a.handle, a.turn_id).await.map(Json) } }
    { "acp_set_permission_tier", auth: Auth::Required, desktop: false, binary: false,
        args: acp_host::SetPermissionTierArgs,
        run: |ctx, a| async move { acp_host::acp_set_permission_tier(&ctx.services.acp, a.handle, a.tier).await.map(Json) } }
    { "acp_list", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs, run: |ctx, _a| async move { acp_host::acp_list(&ctx.services.acp).await.map(Json) } }
    { "acp_detect_programs", auth: Auth::Required, desktop: false, binary: false,
        args: acp_host::DetectProgramsArgs,
        run: |_ctx, a| async move { Ok::<_, String>(Json(acp_host::acp_detect_programs(a.programs))) } }

        }
    };
}
pub(crate) use acp_commands;
