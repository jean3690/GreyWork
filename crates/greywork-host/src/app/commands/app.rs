//! 托盘与更新命令
//!
//! 本域的命令**行宏**：把该域的命令行追加到 `command_table` 的累积列表里。
//! 顺序由 `commands/registry.rs` 的入口链唯一决定（此处不决定前后）。

macro_rules! app_commands {
    ([$next:ident $($rest:ident)*] $($acc:tt)*) => {
        $next! { [$($rest)*] $($acc)*
    // ---- tray（桌面专属） ----
    { "set_close_to_tray", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }
    { "set_tray_labels", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }
    { "close_main_window", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }

    // ---- update ----
    { "check_update", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { update::check_update().await.map(Json) } }
    { "open_external", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }
        }
    };
}
pub(crate) use app_commands;
