//! 交互式终端命令
//!
//! 本域的命令**行宏**：把该域的命令行追加到 `command_table` 的累积列表里。
//! 顺序由 `commands/registry.rs` 的入口链唯一决定（此处不决定前后）。
//!
//! 全组命令在服务端策略里属 `TRUSTED_HOST_ONLY`（见 `apps/server/src/policy.rs`）：PTY 是
//! 比 `shell_run` 更宽的 spawn 面（可持续交互、能跑任意程序），只有「客户端与服务端同机
//! 且受信」（Electron 壳 / 本地宿主）才放行，网络暴露的部署一律 403。

macro_rules! terminal_commands {
    ([$next:ident $($rest:ident)*] $($acc:tt)*) => {
        $next! { [$($rest)*] $($acc)*
    // ---- terminal（交互式终端 / 真 PTY） ----
    // 探测本机可用 shell（cmd / pwsh / Git Bash / WSL / bash / zsh …），供前端选择器。
    { "terminal_shells", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { Ok(Json(ctx.services.terminal.catalog())) } }
    // 列出仍在跑的会话：渲染进程重载 / 面板重挂后据此把标签页接回去。
    { "terminal_list", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { Ok(Json(ctx.services.terminal.list())) } }
    // 开一个新会话：起 PTY + shell 子进程，输出经 `terminal://data` 事件流式下发。
    { "terminal_open", auth: Auth::Required, desktop: false, binary: false,
        args: crate::terminal::OpenArgs,
        run: |ctx, a| async move {
            ctx.services
                .terminal
                .open(ctx.services.workspace.as_ref(), a)
                .map(Json)
        } }
    // 键盘输入（含转义序列）写进会话。
    { "terminal_write", auth: Auth::Required, desktop: false, binary: false,
        args: crate::terminal::WriteArgs,
        run: |ctx, a| async move {
            ctx.services
                .terminal
                .write(&a.session_id, &a.data)
                .map(|()| Json(()))
        } }
    // 通知内核新窗口尺寸（子进程收到 SIGWINCH）。
    { "terminal_resize", auth: Auth::Required, desktop: false, binary: false,
        args: crate::terminal::ResizeArgs,
        run: |ctx, a| async move {
            ctx.services
                .terminal
                .resize(&a.session_id, a.cols, a.rows)
                .map(|()| Json(()))
        } }
    // 关掉会话（杀子进程）。
    { "terminal_close", auth: Auth::Required, desktop: false, binary: false,
        args: crate::terminal::CloseArgs,
        run: |ctx, a| async move {
            ctx.services.terminal.close(&a.session_id);
            Ok(Json(()))
        } }
        }
    };
}
pub(crate) use terminal_commands;
