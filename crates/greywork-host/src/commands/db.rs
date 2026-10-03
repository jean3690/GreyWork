//! 数据库命令
//!
//! 本域的命令**行宏**：把该域的命令行追加到 `command_table` 的累积列表里。
//! 顺序由 `commands/registry.rs` 的入口链唯一决定（此处不决定前后）。

macro_rules! db_commands {
    ([$next:ident $($rest:ident)*] $($acc:tt)*) => {
        $next! { [$($rest)*] $($acc)*
    // ---- db ----
    { "db_settings_load", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs, run: |ctx, _a| async move { ctx.db.load_settings().map(Json) } }
    { "db_settings_sync", auth: Auth::Required, desktop: false, binary: false,
        args: db::SettingsSyncArgs,
        run: |ctx, a| async move { ctx.db.sync_settings(&a.settings).map(Json) } }
    { "db_automations_load", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs, run: |ctx, _a| async move { ctx.db.load_automations().map(Json) } }
    { "db_automations_sync", auth: Auth::Required, desktop: false, binary: false,
        args: db::AutomationsSyncArgs,
        run: |ctx, a| async move { ctx.db.sync_automations(&a.tasks).map(Json) } }
    { "db_automations_due_list", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs, run: |ctx, _a| async move { ctx.db.automation_due_list().map(Json) } }
    { "db_automations_due_finish", auth: Auth::Required, desktop: false, binary: false,
        args: db::DueFinishArgs,
        run: |ctx, a| async move { ctx.db.automation_due_finish(a.id, &a.status).map(Json) } }
    { "db_automation_runs_load", auth: Auth::Required, desktop: false, binary: false,
        args: db::RunsLoadArgs,
        run: |ctx, a| async move { ctx.db.automation_runs_load(a.limit.unwrap_or(200)).map(Json) } }
    { "db_automation_run_record", auth: Auth::Required, desktop: false, binary: false,
        args: db::RunRecordArgs,
        run: |ctx, a| async move { ctx.db.automation_record_run(&a.run).map(Json) } }
    { "db_team_runs_load", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs, run: |ctx, _a| async move { ctx.db.load_team_runs().map(Json) } }
    { "db_team_runs_sync", auth: Auth::Required, desktop: false, binary: false,
        args: db::TeamRunsSyncArgs,
        run: |ctx, a| async move { ctx.db.sync_team_runs(&a.runs).map(Json) } }
    { "db_agents_load", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs, run: |ctx, _a| async move { ctx.db.load_agent_providers().map(Json) } }
    { "db_agents_sync", auth: Auth::Required, desktop: false, binary: false,
        args: db::AgentsSyncArgs,
        run: |ctx, a| async move { ctx.db.sync_agent_providers(&a.providers).map(Json) } }

        }
    };
}
pub(crate) use db_commands;
