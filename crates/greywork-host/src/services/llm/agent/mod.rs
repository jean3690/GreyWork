//! 本机模型 agent 回合：让 OpenAI 兼容端点上的模型能用工具，而不必装外部 ACP agent。
//!
//! 与两条既有路径的关系：
//! - **纯聊天**（`llm_chat_start`）：一次请求一次回答，无工具。这是本模块的退化形态。
//! - **ACP agent**（`services/acp_host.rs`）：大脑在外部，宿主只做协议、权限与门禁。
//!   能力上限取决于那个 agent 自己。
//! - **本模块**：大脑是用户自己的模型端点，工具面由本宿主提供并**在自己的授权面内执行**。
//!   首版只有只读三件套（见 [`tools`]），因此无需交互式权限确认。
//!
//! 为什么不把只读工具做成 MCP 挂给外部 agent：那是「让 agent 来用 GreyWork 的能力」，
//! 这里是「让本地模型成为 agent」，两者的信任边界不同 —— 这里的工具执行发生在
//! GreyWork 自己的进程内、自己的授权面里，不经过外部 agent 的沙箱。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;

use super::dto::LlmChatMessage;
use crate::host::HostContext;
use crate::log;

mod runner;
#[cfg(test)]
mod tests;
pub(crate) mod tools;

pub use runner::{DEFAULT_MAX_ROUNDS, HARD_MAX_ROUNDS};

/// agent 回合的宿主状态：请求 id 分配 + 可中止的任务句柄。
///
/// 与 [`super::LlmHost`](crate::llm::LlmHost) 同构但**独立**：
/// 纯聊天与 agent 回合的生命周期不同（后者可能跑十几轮、几十分钟），共用一张表会让
/// `llm_chat_stop` 有可能 abort 掉一个 agent 回合，反之亦然。id 空间也各走各的，
/// 省掉一类「拿错句柄」的可能。
#[derive(Default)]
pub struct LlmAgentHost {
    next_id: AtomicU64,
    tasks: Mutex<HashMap<u64, tokio::task::JoinHandle<()>>>,
}

impl LlmAgentHost {
    /// 让句柄失效：回合结束时**自己**摘掉，否则长跑会话会攒下大量已完成的
    /// `JoinHandle`（与 `LlmHost::streams` 同一个理由）。
    fn release(&self, request_id: u64) {
        self.tasks.lock().remove(&request_id);
    }
}

/// `llm_agent_start` 的命令入参（dispatch 扁平入参，`camelCase`）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartArgs {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key_env: String,
    pub messages: Vec<LlmChatMessage>,
    #[serde(default)]
    pub reasoning_effort: String,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// 工具回合上限；缺省 [`DEFAULT_MAX_ROUNDS`]，超过 [`HARD_MAX_ROUNDS`] 会被夹住。
    #[serde(default)]
    pub max_rounds: Option<u32>,
    #[serde(default)]
    pub client_token: Option<String>,
}

/// 发起一个 agent 回合；返回请求 id（用于中止）。
///
/// 参数校验放在这里而不是循环里：空 base_url / model 是调用方的配置错误，
/// 早返回比 spawn 一个任务再 emit 一条 `llm-error` 干净。
///
/// `access` 收 `Arc` 而非 `&`：任务是 spawn 出去的，要自己持有授权面到回合结束
/// （否则借用活不过 `'static`，工具执行到一半就没有可校验的授权根了）。
pub async fn llm_agent_start(
    host: Arc<dyn HostContext>,
    agent: &Arc<LlmAgentHost>,
    access: Arc<crate::workspace_fs::WorkspaceFsAccess>,
    args: AgentStartArgs,
) -> Result<u64, String> {
    let base_url = args.base_url.trim().to_string();
    let model = args.model.trim().to_string();
    if base_url.is_empty() || model.is_empty() {
        return Err("base_url and model are required".to_string());
    }
    if args.messages.is_empty() {
        return Err("messages 不能为空".to_string());
    }
    let request_id = agent.next_id.fetch_add(1, Ordering::SeqCst);
    let client_token = args.client_token.unwrap_or_default();
    let turn = runner::AgentTurn {
        base_url,
        model,
        api_key_env: args.api_key_env,
        messages: super::transport::messages_wire(args.messages),
        reasoning_effort: args.reasoning_effort,
        headers: args.headers.unwrap_or_default(),
        temperature: args.temperature,
        max_tokens: args.max_tokens,
        max_rounds: args
            .max_rounds
            .unwrap_or(DEFAULT_MAX_ROUNDS)
            .clamp(1, HARD_MAX_ROUNDS),
        client_token: client_token.clone(),
    };

    // 先持锁再插入句柄：回合结束时会自己摘除，若它在插入前就跑到摘除那一步，
    // 那次 remove 会落空、句柄永久残留。
    let mut tasks = agent.tasks.lock();
    let handle = Arc::clone(agent);
    let model = turn.model.clone();
    let task = tokio::spawn(async move {
        runner::run(host.as_ref(), access.as_ref(), turn).await;
        handle.release(request_id);
    });
    tasks.insert(request_id, task);
    log::info(
        "llm-agent",
        format!("start request={request_id} model={model}"),
    );
    Ok(request_id)
}

/// 中止进行中的 agent 回合并回收句柄。
pub async fn llm_agent_stop(agent: &LlmAgentHost, request_id: u64) -> Result<(), String> {
    let task = agent.tasks.lock().remove(&request_id);
    match task {
        Some(task) => {
            task.abort();
            Ok(())
        }
        None => Err(format!("unknown llm agent request {request_id}")),
    }
}
