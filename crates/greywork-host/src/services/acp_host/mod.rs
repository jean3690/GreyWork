//! ACP 主机：spawn 外部 agent（stdio JSON-RPC）、会话生命周期、Tauri 命令桥。
//!
//! 传输由 `acp_process` 托管（宿主自己 spawn，进程树守卫负责回收），本模块只持有
//! 连接句柄与生命周期。安全模型（宿主强制，前端档位仅作选择入口）：
//! - 权限档位在 `acp_start` 传入，**按 handle 存放**并在宿主执行：
//!   `cautious` → 全部转发前端逐条确认；`daily` → 仅只读类工具
//!   （read / search / fetch / think）自动放行，其余转发前端；`auto` → 直通首个
//!   Allow 选项。未知档位按 `cautious` 处理（fail-closed）。
//! - 写类工具（edit / delete / move）的路径必须落在本 handle 的会话工作区内，
//!   越界一律拒绝，任何档位（含 auto）都不可绕过。
//! - agent 启动命令经白名单校验：拒绝 shell 元字符；程序名必须在内置列表内，
//!   或在用户显式启用的自配后端目录里（`db.enabled_agent_programs`）。
//! - 会话 cwd 必须是已存在的绝对路径目录，且不得为文件系统根。
//!
//! # 子模块
//!
//! - [`policy`]：权限档位与决策纯逻辑（含路径锚定 / cwd 校验）；
//! - [`state`]：`AcpHost` / `AcpSession` 等运行时状态与事件发射；
//! - [`permission`]：权限请求的转发、裁决回传与待决释放；
//! - [`events`]：ACP `session/update` 通知的分类转发；
//! - [`artifacts`]：回合产物扫描；
//! - [`env`]：启动命令白名单、环境变量净化、握手超时窗口；
//! - [`start`]：`acp_start`（spawn + initialize 握手）；
//! - [`session`]：会话生命周期（new / resume / load / close / set_config / set_mode / set_permission_tier / list）；
//! - [`prompt`]：prompt 组装、发送与停止（`acp_send` / `acp_stop`）；
//! - [`probe`]：agent 入口程序探测；
//! - [`commands`]：命令入参。

mod artifacts;
mod commands;
mod env;
mod events;
mod permission;
mod policy;
mod probe;
mod prompt;
mod session;
mod start;
mod state;

#[cfg(test)]
mod tests;

pub use commands::{
    CancelSessionArgs, CloseSessionArgs, DetectProgramsArgs, LoadSessionArgs, NewSessionArgs,
    PermissionRespondArgs, SendArgs, SetConfigArgs, SetModeArgs, SetPermissionTierArgs, StartArgs,
    StopArgs,
};
pub use permission::acp_permission_respond;
pub use probe::{acp_detect_programs, AgentProgramProbe};
pub use prompt::{acp_cancel_session, acp_send, acp_stop, PromptUnit};
pub use session::{
    acp_close_session, acp_list, acp_load_session, acp_new_session, acp_set_config, acp_set_mode,
    acp_set_permission_tier,
};
pub use start::acp_start;
pub use state::AcpHost;
