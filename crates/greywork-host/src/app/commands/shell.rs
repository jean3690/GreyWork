//! 终端 / 命令运行命令
//!
//! 本域的命令**行宏**：把该域的命令行追加到 `command_table` 的累积列表里。
//! 顺序由 `commands/registry.rs` 的入口链唯一决定（此处不决定前后）。

macro_rules! shell_commands {
    ([$next:ident $($rest:ident)*] $($acc:tt)*) => {
        $next! { [$($rest)*] $($acc)*
    // ---- shell（终端命令运行器） ----
    // 服务端策略里属 `TRUSTED_HOST_ONLY`（见 apps/server/src/policy.rs）：只有
    // 「客户端与服务端同机且受信」（Electron 壳 / 本地宿主）才放行，网络暴露的部署 403。
    // 与 agent 启动不同，这里刻意不套白名单 —— 用户显式要跑一条 shell 命令，元字符与管道
    // 正是功能本身；安全边界改由「谁能调用」承担。
    { "shell_run", auth: Auth::Required, desktop: false, binary: false,
        args: shell::RunArgs,
        run: |ctx, a| async move { shell::run(&ctx.services.workspace, a).await.map(Json) } }
        }
    };
}
pub(crate) use shell_commands;
