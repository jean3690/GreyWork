//! 数据面 DTO：与前端形状对齐的 serde 结构（会话快照 / 编排存档 / ACP 后端 / 自动化 / RAG 分块）。

use serde::{Deserialize, Serialize};

/// 单条会话的快照视图（camelCase 对齐前端 SessionRecord 字段）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDto {
    pub id: String,
    pub title: String,
    pub workspace_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// ThreadMessage 全文（不透明 JSON：steps/tools/thinking 等字段原样往返）。
    pub messages: Vec<serde_json::Value>,
}

/// 全量快照（sync / load 共用形状）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionsSnapshotDto {
    pub sessions: Vec<ConversationDto>,
    pub active_session_id: Option<String>,
}

/// 编排运行存档行：PlannerRun 全文不透明（subtasks 等字段原样往返），
/// id 拆列便于删除与去重（id 亦在 payload 内，sync 时校验一致性）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunDto {
    pub id: String,
    pub payload: serde_json::Value,
}

/// ACP 后端目录项（与前端 AgentProviderConfig 对齐；enabled 由宿主持久化，
/// 前端只做首次 seed——目录真源归 Rust，渲染端不再硬编码启停）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderDto {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub command: String,
    pub enabled: bool,
    /// 启动环境变量（JSON 对象文本：`{"KEY":"VALUE"}`）；None = 继承宿主环境。
    /// 与 command 同属「能被启动的契约」，因此进库而不是留在渲染端的展示覆盖层。
    #[serde(default)]
    pub env: Option<String>,
}

/// 自动化任务行（与前端 AutomationTask 对齐；cron 空 = 手动触发，永不自动到期）。
/// running 为运行期瞬时态，不落库（load 后前端统一置 false）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTaskDto {
    pub id: String,
    pub name: String,
    /// 人类可读触发描述（如「每天 09:00」）。
    pub schedule: String,
    /// 标准 cron 5 段表达式（分 时 日 月 周）；None = 手动触发。
    pub cron: Option<String>,
    /// 一次性任务的触发时刻（epoch ms）；None = 按 cron 循环。
    pub once_at: Option<i64>,
    /// 执行后端：ACP 后端 id；None = 本机模型管线。
    pub acp_provider_id: Option<String>,
    pub target: String,
    pub intent: String,
    pub enabled: bool,
    /// 最近一次运行时间戳（epoch ms；0 = 从未）。
    pub last_run: i64,
}

/// 到期执行队列行（宿主 push 的 pending 快照；渲染端消费后 finish）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDueDto {
    pub id: i64,
    pub task_id: String,
    pub name: String,
    pub target: String,
    pub intent: String,
    /// 入队时刻的执行后端快照（与 intent 同源）。
    pub acp_provider_id: Option<String>,
    pub due_at: i64,
}

/// 运行记录行（宿主与渲染端两条执行路径共写；渲染端 hydrate 回读展示）。
/// mode: llm=本机模型 / acp=指定后端 / host=宿主无人值守兜底。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunDto {
    pub id: i64,
    pub task_id: String,
    pub name: String,
    /// "success" | "failed"。
    pub status: String,
    /// 成功时为回复预览、失败时为错误文案；可空。
    pub detail: Option<String>,
    /// 关联会话 id（可点进查看）；宿主兜底跑也建会话。None = 无。
    pub session_id: Option<String>,
    pub mode: String,
    pub ran_at: i64,
}

/// 记一条运行结果的入参（id 由库自增分配，故不含）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunInputDto {
    pub task_id: String,
    pub name: String,
    pub status: String,
    pub detail: Option<String>,
    pub session_id: Option<String>,
    pub mode: String,
    pub ran_at: i64,
}

/// 一条待写入的 RAG 分块（向量已算好）。
pub struct RagChunkDto {
    pub chunk_index: i64,
    pub text: String,
    pub vec: Vec<f32>,
}

/// 一条已索引的 RAG 分块（检索单元）。
pub struct RagChunkRow {
    pub path: String,
    pub chunk_index: i64,
    pub text: String,
    pub vec: Vec<f32>,
}
