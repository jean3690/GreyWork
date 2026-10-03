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
        run: |ctx, a| async move { office::open_preview(&ctx.workspace, a).await.map(Json) } }

        }
    };
}
pub(crate) use office_commands;
