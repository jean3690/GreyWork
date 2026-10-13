//! 工作区文件系统与表格命令
//!
//! 本域的命令**行宏**：把该域的命令行追加到 `command_table` 的累积列表里。
//! 顺序由 `commands/registry.rs` 的入口链唯一决定（此处不决定前后）。

macro_rules! fs_commands {
    ([$next:ident $($rest:ident)*] $($acc:tt)*) => {
        $next! { [$($rest)*] $($acc)*
    // ---- workspace_fs ----
    { "fs_read_text_file", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::PathArg,
        run: |ctx, a| async move { workspace_fs::fs_read_text_file(&ctx.services.workspace, a.path).map(Json) } }
    { "fs_read_binary", auth: Auth::Required, desktop: false, binary: true,
        args: workspace_fs::PathArg,
        run: |ctx, a| async move { workspace_fs::fs_read_binary(&ctx.services.workspace, a.path).map(Bin) } }
    { "fs_read_media", auth: Auth::Required, desktop: false, binary: true,
        args: workspace_fs::MediaArg,
        run: |ctx, a| async move { workspace_fs::fs_read_media(&ctx.services.workspace, a.path, a.max_bytes).map(Bin) } }
    { "fs_probe_file", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::PathArg,
        run: |ctx, a| async move { workspace_fs::fs_probe_file(&ctx.services.workspace, a.path).map(Json) } }
    { "fs_write_text_file", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::WriteTextArg,
        run: |ctx, a| async move { workspace_fs::fs_write_text_file(&ctx.services.workspace, a.path, a.content).map(Json) } }
    { "fs_write_binary", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::WriteBinaryArg,
        run: |ctx, a| async move { workspace_fs::fs_write_binary(&ctx.services.workspace, a.path, a.data_base64).map(Json) } }
    { "fs_ensure_dir", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::PathArg,
        run: |ctx, a| async move { workspace_fs::fs_ensure_dir(&ctx.services.workspace, a.path).map(Json) } }
    { "fs_create_file", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::PathArg,
        run: |ctx, a| async move { workspace_fs::fs_create_file(&ctx.services.workspace, a.path).map(Json) } }
    { "fs_create_dir", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::PathArg,
        run: |ctx, a| async move { workspace_fs::fs_create_dir(&ctx.services.workspace, a.path).map(Json) } }
    { "fs_rename_path", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::TransferArg,
        run: |ctx, a| async move { workspace_fs::fs_rename_path(&ctx.services.workspace, a.from, a.to).map(Json) } }
    { "fs_copy_path", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::TransferArg,
        run: |ctx, a| async move { workspace_fs::fs_copy_path(&ctx.services.workspace, a.from, a.to).map(Json) } }
    { "fs_delete_path", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::PathArg,
        run: |ctx, a| async move { workspace_fs::fs_delete_path(&ctx.services.workspace, a.path).map(Json) } }
    { "fs_list_dir", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::PathArg,
        run: |ctx, a| async move { workspace_fs::fs_list_dir(&ctx.services.workspace, a.path).map(Json) } }
    // 授权面唯一的命令入口（受 `policy::TRUSTED_HOST_ONLY` 守，不可信部署 403）。宿主壳本可
    // 自行授权（Tauri 就是在 Rust 的 Drop 分支 / 对话框回调里做的），但渲染端拿到绝对路径
    // 而宿主不知情的宿主只能显式声明。两条命令语义不同，见 `workspace_fs::authorize`。
    { "fs_authorize_drop_paths", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::AuthorizePathsArg,
        run: |ctx, a| async move { workspace_fs::fs_authorize_drop_paths(&ctx.services.workspace, a.paths).map(|()| Json(serde_json::Value::Null)) } }
    { "fs_authorize_picked_paths", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::AuthorizePathsArg,
        run: |ctx, a| async move { workspace_fs::fs_authorize_picked_paths(&ctx.services.workspace, a.paths).map(Json) } }
    { "fs_pick_files", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }

    // ---- sheet ----
    { "fs_read_sheet", auth: Auth::Required, desktop: false, binary: false,
        args: sheet::ReadSheetArgs,
        run: |ctx, a| async move { sheet::fs_read_sheet(ctx.services.workspace.as_ref(), a.path, a.sheet, a.max_rows).map(Json) } }

        }
    };
}
pub(crate) use fs_commands;
