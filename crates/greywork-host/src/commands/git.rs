//! git / store_fs / worktree 命令
//!
//! 本域的命令**行宏**：把该域的命令行追加到 `command_table` 的累积列表里。
//! 顺序由 `commands/registry.rs` 的入口链唯一决定（此处不决定前后）。

macro_rules! git_commands {
    ([$next:ident $($rest:ident)*] $($acc:tt)*) => {
        $next! { [$($rest)*] $($acc)*
    // ---- git ----
    { "git_status", auth: Auth::Required, desktop: false, binary: false,
        args: git::RootArg,
        run: |ctx, a| async move { git::git_status(ctx.services.workspace.as_ref(), a.root).map(Json) } }
    { "git_changes", auth: Auth::Required, desktop: false, binary: false,
        args: git::RootArg,
        run: |ctx, a| async move { git::git_changes(ctx.services.workspace.as_ref(), a.root).map(Json) } }
    { "git_diff", auth: Auth::Required, desktop: false, binary: false,
        args: git::DiffArgs,
        run: |ctx, a| async move { git::git_diff(ctx.services.workspace.as_ref(), a.root, a.path, a.staged).map(Json) } }
    { "git_stage", auth: Auth::Required, desktop: false, binary: false,
        args: git::StageArgs,
        run: |ctx, a| async move { git::git_stage(ctx.services.workspace.as_ref(), a.root, a.paths, a.all).map(Json) } }
    { "git_unstage", auth: Auth::Required, desktop: false, binary: false,
        args: git::StageArgs,
        run: |ctx, a| async move { git::git_unstage(ctx.services.workspace.as_ref(), a.root, a.paths, a.all).map(Json) } }
    { "git_commit", auth: Auth::Required, desktop: false, binary: false,
        args: git::CommitArgs,
        run: |ctx, a| async move { git::git_commit(ctx.services.workspace.as_ref(), a.root, a.message, a.all).map(Json) } }
    { "git_current_branch", auth: Auth::Required, desktop: false, binary: false,
        args: git::RootArg,
        run: |ctx, a| async move { git::git_current_branch(ctx.services.workspace.as_ref(), a.root).map(Json) } }
    { "git_branch_list", auth: Auth::Required, desktop: false, binary: false,
        args: git::RootArg,
        run: |ctx, a| async move { git::git_branch_list(ctx.services.workspace.as_ref(), a.root).map(Json) } }
    { "git_log", auth: Auth::Required, desktop: false, binary: false,
        args: git::LogArgs,
        run: |ctx, a| async move { git::git_log(ctx.services.workspace.as_ref(), a.root, a.limit, a.skip).map(Json) } }
    { "git_show", auth: Auth::Required, desktop: false, binary: false,
        args: git::ShowArgs,
        run: |ctx, a| async move { git::git_show(ctx.services.workspace.as_ref(), a.root, a.hash, a.path).map(Json) } }

    // ---- store_fs ----
    { "store_sessions_load", auth: Auth::Required, desktop: false, binary: false,
        args: store_fs::SessionsLoadArgs,
        run: |ctx, a| async move { store_fs::store_sessions_load(ctx.host.as_ref(), &ctx.services.db, ctx.services.workspace.as_ref(), a.workspaces).map(Json) } }
    { "store_sessions_sync", auth: Auth::Required, desktop: false, binary: false,
        args: store_fs::SessionsSyncArgs,
        run: |ctx, a| async move { store_fs::store_sessions_sync(ctx.host.as_ref(), ctx.services.workspace.as_ref(), a.snapshot, a.workspaces, a.deleted_session_ids).map(Json) } }
    { "store_default_root", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { store_fs::store_default_root(ctx.host.as_ref()).map(Json) } }
    { "attachments_prune_session", auth: Auth::Required, desktop: false, binary: false,
        args: store_fs::PruneSessionArgs,
        run: |ctx, a| async move { store_fs::attachments_prune_session(ctx.host.as_ref(), a.session_id).map(Json) } }
    { "store_sessions_relocate", auth: Auth::Required, desktop: false, binary: false,
        args: store_fs::RelocateRequestDto,
        run: |ctx, a| async move { store_fs::store_sessions_relocate(ctx.host.as_ref(), ctx.services.workspace.as_ref(), a).map(Json) } }
    { "pick_workspace_folder", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }

    // ---- worktree ----
    { "worktree_provision", auth: Auth::Required, desktop: false, binary: false,
        args: worktree::ProvisionArgs,
        run: |ctx, a| async move { worktree::worktree_provision(ctx.host.as_ref(), ctx.services.workspace.as_ref(), a.source).map(Json) } }
    { "worktree_release", auth: Auth::Required, desktop: false, binary: false,
        args: worktree::ReleaseArgs,
        run: |ctx, a| async move { worktree::worktree_release(ctx.host.as_ref(), ctx.services.workspace.as_ref(), a.root).map(Json) } }
    { "worktree_list", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { worktree::worktree_list(ctx.host.as_ref()).map(Json) } }

        }
    };
}
pub(crate) use git_commands;
