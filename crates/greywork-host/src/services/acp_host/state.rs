//! 运行时状态（`AcpHost` / `AcpSession`）与事件发射。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;

use agent_client_protocol::schema::v1::{
    McpCapabilities, PermissionOptionId, RequestId, SessionId, SessionModeState,
};
use agent_client_protocol::{Agent as AgentRole, ConnectionTo};
use serde::Serialize;
use tokio::sync::oneshot;
use tokio::sync::Mutex;

use crate::host::HostContext;

use super::policy::{PermissionTier, SessionPolicy};

/// 前端对一条权限请求的裁决。
pub(super) enum PermissionDecision {
    Select(PermissionOptionId),
    Cancel,
}

/// 事件信封：统一 kind + payload，前端按 kind 分流渲染。
#[derive(Serialize, Clone)]
struct AcpEventEnvelope {
    kind: &'static str,
    payload: serde_json::Value,
}

pub(super) struct AcpSession {
    pub(super) command: String,
    pub(super) conn: ConnectionTo<AgentRole>,
    pub(super) task: tokio::task::JoinHandle<()>,
    pub(super) session_id: Option<SessionId>,
    /// 在途 prompt 回合：turn_id → 对应 JSON-RPC 请求 id。
    /// acp_stop(handle, turn_id) 据此发 `$/cancel_request` 精确取消单回合，
    /// 不杀 agent 进程（会话与后续回合保留）。
    pub(super) turns: HashMap<u64, RequestId>,
    /// 本 handle 的权限档位（acp_start 传入）。按 handle 存而非全局：编排会
    /// 并发起多个 agent，全局档位会被后启动者覆盖。
    pub(super) tier: PermissionTier,
    /// 本 handle 的工作区根（文件系统锚定基准），由 acp_new_session 建立。
    /// None = 尚未建会话，无锚定基准可比。
    pub(super) workspace_root: Option<PathBuf>,
    /// 本 handle 的 agent 所声明的 MCP 传输能力（initialize 回包）。
    /// 按协议只能在声明过的传输上给它 MCP 服务器，否则 session/new 会整体失败。
    pub(super) mcp_capabilities: McpCapabilities,
    /// 本 handle 的 agent 是否支持 `session/load`（initialize 回包）。
    /// 不支持时前端回落 session/new，宿主也不发无谓请求。
    pub(super) load_session: bool,
    /// 本 handle 的 agent 是否支持 `session/resume`（`sessionCapabilities.resume`）。
    /// 恢复会话时优先走 resume：它不重放历史，前端不必再开回放抑制窗口，
    /// 比 load 更快也更干净；只有 resume 不可用 / 失败时才回落 load。
    pub(super) resume_session: bool,
    /// 本 handle 的 agent 是否支持 `session/close`（`sessionCapabilities.close`）。
    /// 切换对话时宿主据此释放旧会话；不支持则静默跳过，进程仍可复用。
    pub(super) close_session: bool,
    /// 当前会话的旧版模式状态（`session/new` / `load` / `resume` 回包里的 `modes`）。
    /// 声明了可用模式才允许 `session/set_mode`；None = 该 agent 不暴露旧版模式。
    pub(super) modes: Option<SessionModeState>,
    /// 本 handle 的 agent 是否接受图片 prompt（initialize 回包 `promptCapabilities.image`）。
    /// 前端据此置灰图片入口；宿主侧再兜一层过滤，避免把图片发给只认文本的 agent。
    pub(super) image_prompts: bool,
}

/// 待前端裁决的权限请求：应答通道 + 归属 handle。
/// 归属 handle 让 acp_stop 能精确清空该会话的待决项，否则会话结束后
/// 这些 sender 会一直悬挂到 PERMISSION_CONFIRM_TIMEOUT。
pub(super) struct PendingPermission {
    pub(super) handle: u64,
    pub(super) responder: oneshot::Sender<PermissionDecision>,
}

/// 全局主机状态（由各宿主 `manage` / 持有）。档位与工作区根都随 session 存放，
/// 见 `AcpSession::tier` / `AcpSession::workspace_root`。
#[derive(Default)]
pub struct AcpHost {
    pub(super) next_id: AtomicU64,
    pub(super) next_permission_id: AtomicU64,
    pub(super) next_turn_id: AtomicU64,
    pub(super) sessions: Mutex<HashMap<u64, AcpSession>>,
    pub(super) pending_permissions: Mutex<HashMap<u64, PendingPermission>>,
}

pub(super) fn emit(host: &dyn HostContext, kind: &'static str, payload: serde_json::Value) {
    crate::host::emit_json(host, "acp://event", AcpEventEnvelope { kind, payload });
}

impl AcpHost {
    /// 活跃 ACP 进程数（系统诊断面）。
    pub async fn session_count(&self) -> usize {
        self.sessions.lock().await.len()
    }

    /// 取出某 handle 的决策上下文快照；handle 未登记时返回最严兜底。
    pub(super) async fn policy_for(&self, handle: u64) -> SessionPolicy {
        self.sessions
            .lock()
            .await
            .get(&handle)
            .map(|session| SessionPolicy {
                tier: session.tier,
                workspace_root: session.workspace_root.clone(),
            })
            .unwrap_or_default()
    }

    /// 就地改写某 handle 的权限档位（临时降级/回升）。
    ///
    /// `resolve_permission` 每条请求都重新 `policy_for(handle)`，因此改档对**在途会话
    /// 立即生效**，无需重启 agent 进程 —— 这正是「Full 会话内一键降 ReadOnly 跑完再升」
    /// 能保住上下文的原因。未登记的 handle 返回错误而不静默成功，避免前端以为降级了。
    pub(super) async fn set_tier(&self, handle: u64, tier: PermissionTier) -> Result<(), String> {
        self.sessions
            .lock()
            .await
            .get_mut(&handle)
            .map(|session| session.tier = tier)
            .ok_or_else(|| format!("unknown handle {handle}"))
    }
}
