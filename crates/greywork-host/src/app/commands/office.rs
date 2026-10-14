//! 第三方云端 Office 预览命令
//!
//! 本域的命令**行宏**：把该域的命令行追加到 `command_table` 的累积列表里。
//! 顺序由 `commands/registry.rs` 的入口链唯一决定（此处不决定前后）。

macro_rules! office_commands {
    ([$next:ident $($rest:ident)*] $($acc:tt)*) => {
        $next! { [$($rest)*] $($acc)*
    // ---- office（第三方云端 Office 预览） ----
    // `office` 本身无状态（配方随调用传入，凭证每次从环境变量解析），与 LlmHost / WecomHost
    // 那种「持有连接与请求句柄」的不同；`office_host_info` 读 `ctx.frame_origins` 只是为了
    // 把宿主自己的 CSP 白名单如实回给渲染端（桌面与服务端各是一份真值）。
    { "office_host_info", auth: Auth::Required, desktop: false, binary: false,
        args: office::HostInfoArgs,
        run: |ctx, a| async move { Ok::<_, String>(Json(office::host_info(&ctx.frame_origins, a))) } }
    { "office_preview_open", auth: Auth::Required, desktop: false, binary: false,
        args: office::PreviewOpenArgs,
        run: |ctx, a| async move {
            office::open_preview(&ctx.host.paths().app_data_dir, &ctx.services.workspace, a)
                .await
                .map(Json) } }

    // ---- office：扫码授权（OAuth 2.0 授权码流） ----
    // 宿主**不持有在飞会话**：begin 生成 state 后交渲染端保管，submit 时原样回传校验；
    // 令牌按 client_id 落在 `<app_data>/office/credentials.json`。因此不需要新的 host 结构，
    // 桌面与服务端共用这一份（见 services/office/auth.rs 的模块注释）。
    { "office_oauth_begin", auth: Auth::Required, desktop: false, binary: false,
        args: office::OAuthBeginArgs,
        run: |_ctx, a| async move { office::oauth_begin(a).map(Json) } }
    { "office_oauth_submit", auth: Auth::Required, desktop: false, binary: false,
        args: office::OAuthSubmitArgs,
        run: |ctx, a| async move {
            office::oauth_submit(&ctx.host.paths().app_data_dir, a).await.map(Json) } }
    { "office_oauth_status", auth: Auth::Required, desktop: false, binary: false,
        args: office::OAuthStatusArgs,
        run: |ctx, a| async move {
            Ok::<_, String>(Json(office::oauth_status(&ctx.host.paths().app_data_dir, a))) } }
    { "office_oauth_logout", auth: Auth::Required, desktop: false, binary: false,
        args: office::OAuthLogoutArgs,
        run: |ctx, a| async move {
            office::oauth_logout(&ctx.host.paths().app_data_dir, a).map(Json) } }

        }
    };
}
pub(crate) use office_commands;
