//! 命令注册表核心：`CommandContext`、`command_table!` 终端宏与分发入口。
//!
//! 各领域命令行由 `commands/<domain>.rs` 的行宏累积，入口链见文件末尾。

use std::sync::Arc;

use serde_json::Value;

use crate::acp_host::AcpHost;
use crate::channel_common::{
    AppSecretArg, BotSecretArg, ClientSecretArg, ConnectArgs, PeerTextArgs, TokenArg,
};
use crate::db::Db;
use crate::dingtalk::DingTalkHost;
use crate::discord::DiscordHost;
use crate::feishu::FeishuHost;
use crate::host::HostContext;
use crate::llm::LlmHost;
use crate::qq::QqHost;
use crate::rag::RagHost;
use crate::telegram::TelegramHost;
use crate::wechat::WechatHost;
use crate::wecom::WecomHost;
use crate::workspace_fs::WorkspaceFsAccess;
use crate::{
    acp_host, bundled_skills, channel_media, db, dingtalk, discord, feishu, git, llm, mcp,
    mcp_registry, office, plugin_market, qq, rag, sheet, skills_market, store_fs, sys, telegram,
    update, web_fetch, wechat, wecom, workspace_fs, worktree,
};

/// 命令的鉴权要求。
///
/// 目前全部是 [`Auth::Required`]：服务端是单用户自托管 + 内置登录，登录命令本身尚未落地
/// （阶段 3）。字段先留着，等登录/健康检查这类免鉴权命令进来时不必再改表结构。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Auth {
    /// 需登录态。
    Required,
    /// 免鉴权（尚未有命令使用）。
    None,
}

/// 单条命令的元数据。
#[derive(Clone, Copy, Debug)]
pub struct CommandMeta {
    /// 命令名（与桌面 `generate_handler!` 里的一致）。
    pub name: &'static str,
    /// 鉴权要求。
    pub auth: Auth,
    /// 是否桌面专属（headless `dispatch` 直接拒绝）。
    pub desktop_only: bool,
    /// 返回值是否为原始字节（`CommandOutput::Binary`）。
    pub binary: bool,
}

/// `dispatch` 的返回值：JSON 或原始字节。
#[derive(Debug)]
pub enum CommandOutput {
    Json(Value),
    Binary(Vec<u8>),
}

/// 服务端的命令上下文：启动期建一次，跨请求复用。
///
/// 桌面端**不构造**它 —— Tauri 用 `State<'_, T>` 管理这些状态，命令签名各自声明即可。
/// 这里持 `Arc<T>` 是为了让服务端能把同一份状态交给并发请求。
pub struct CommandContext {
    pub host: Arc<dyn HostContext>,
    pub db: Arc<Db>,
    pub workspace: Arc<WorkspaceFsAccess>,
    pub acp: Arc<AcpHost>,
    pub llm: Arc<LlmHost>,
    pub rag: Arc<RagHost>,
    pub wechat: Arc<WechatHost>,
    pub dingtalk: Arc<DingTalkHost>,
    pub feishu: Arc<FeishuHost>,
    pub telegram: Arc<TelegramHost>,
    pub discord: Arc<DiscordHost>,
    pub qq: Arc<QqHost>,
    pub wecom: Arc<WecomHost>,
    /// 在 [`crate::acp_host`] 内置白名单之外额外放行的 agent 程序名。
    ///
    /// 桌面端不构造 `CommandContext`（该值由桌面包装自行从 `db.enabled_agent_programs()`
    /// 取）；服务端填配置里**冻结**的列表，不读 DB —— DB 可被客户端经 `db_agents_sync`
    /// 改写，是 RCE 面（见 `acp_host::acp_start` 的 `extra_programs` 说明）。
    pub agent_programs: Arc<Vec<String>>,
    /// 本宿主 CSP 允许内嵌的 origin（云端 Office 的文档地址）。
    ///
    /// 与 `agent_programs` 同样是**宿主侧事实**：桌面端写死在 `tauri.conf.json`（由桌面包装
    /// 自行传给 `office::host_info`），服务端填 `GREYWORK_FRAME_ORIGINS`。共享层无从得知，
    /// 只能由宿主注入 —— 所以 `office_host_info` 是本表里少数要读 `ctx` 的「无状态」命令。
    pub frame_origins: Arc<Vec<String>>,
    /// 宿主侧事实（版本 / 托盘有无 / 配置钉住的沙箱与档位），`sys_info` 消费。
    ///
    /// 与 `agent_programs` / `frame_origins` 同一注入风格。桌面端不构造
    /// `CommandContext`（其 `#[tauri::command]` 包装自行填 [`sys::HostFacts`]）。
    pub host_facts: sys::HostFacts,
}

/// 零参命令的占位入参：`null` / `{}` / 缺失都接受。
///
/// 不用 `()` 是因为 `serde` 只认 `null`，而前端/HTTP 客户端对「无参」的表示并不统一
/// （可能发 `{}` 或空 body）。零参命令不该因载荷形态不同而失败。
#[derive(Default)]
pub struct UnitArgs;

impl<'de> serde::Deserialize<'de> for UnitArgs {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // 吞掉任意载荷 —— 有值没值都当零参。
        let _ = <serde::de::IgnoredAny as serde::Deserialize>::deserialize(deserializer)?;
        Ok(UnitArgs)
    }
}

/// JSON 结果包装：把「可序列化的返回值」与「原始字节」在 `dispatch` 里统一收口。
pub struct Json<T>(pub T);

/// 原始字节结果包装（`binary` 命令）。
pub struct Bin(pub Vec<u8>);

/// 把命令实现的返回值转成 [`CommandOutput`]。
pub trait IntoCommandOutput {
    fn into_output(self) -> Result<CommandOutput, String>;
}

impl IntoCommandOutput for Bin {
    fn into_output(self) -> Result<CommandOutput, String> {
        Ok(CommandOutput::Binary(self.0))
    }
}

impl<T: serde::Serialize> IntoCommandOutput for Json<T> {
    fn into_output(self) -> Result<CommandOutput, String> {
        serde_json::to_value(self.0)
            .map(CommandOutput::Json)
            .map_err(|error| format!("命令结果序列化失败: {error}"))
    }
}

/// 从 `dispatch` 的 JSON 载荷反序列化命令入参。
fn parse_args<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|error| format!("命令参数解析失败: {error}"))
}

/// 调用命令实现闭包。
///
/// 存在的意义是给闭包参数**显式类型**：`|ctx, a| async move { … }` 直接调用时，Rust 在
/// 检查 `async` 块之前拿不到闭包参数类型（会报 E0282）。走一层带 `FnOnce(&CommandContext, A)`
/// 约束的泛型函数，参数类型由约束反推，139 条命令不必各写一遍类型标注。
fn run_command<'a, A, F, Fut, T>(run: F, ctx: &'a CommandContext, a: A) -> Fut
where
    F: FnOnce(&'a CommandContext, A) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>> + 'a,
    T: IntoCommandOutput,
{
    run(ctx, a)
}

/// `channel_send_media` 的服务端分发：把各通道 host 摆进注册表，交给共享层统一分发。
///
/// 桌面壳里等价的一份用 `app.state::<XHost>()` 装配同一个 [`channel_media::ChannelRegistry`]，
/// 分发逻辑（[`channel_media::send_media_via`]）只此一处。
async fn channel_send_media(
    ctx: &CommandContext,
    args: channel_media::SendMediaArgs,
) -> Result<(), String> {
    let media = channel_media::prepare_outbound(
        ctx.workspace.as_ref(),
        &args.channel,
        &args.path,
        args.kind.as_deref(),
    )?;
    let registry = channel_media::ChannelRegistry::new()
        .register("wechat", &*ctx.wechat)
        .register("telegram", &*ctx.telegram)
        .register("discord", &*ctx.discord)
        .register("feishu", &*ctx.feishu)
        .register("qq", &*ctx.qq)
        .register("wecom", &*ctx.wecom);
    channel_media::send_media_via(
        &registry,
        &ctx.host,
        &args.channel,
        &args.peer_id,
        args.context_token.as_deref(),
        media,
    )
    .await
}

/// 命令表宏：一次声明同时生成 [`COMMANDS`] 与 [`dispatch`]。
///
/// 入参形如 `command_table! { [] <行>… }`：`[]` 是领域链走完后剩下的空后继表，
/// 其后是各领域宏累积出来的命令行（与拆分前逐字一致）。
/// 每条命令一行，`run` 闭包返回 `Result<Json<T>, String>`（JSON 命令）或
/// `Result<Bin, String>`（binary 命令）。`desktop: true` 的条目其 `run` 不会被调用
/// （`dispatch` 在解析入参前就返回），但仍需语法合法。
macro_rules! command_table {
    ( [] $(
        { $name:literal, auth: $auth:expr, desktop: $desktop:tt, binary: $binary:tt,
            args: $args:ty, run: $run:expr }
    )*) => {
        /// 全部命令的元数据。桌面 `generate_handler!` 与之一一对应（漂移测试保证）。
        pub const COMMANDS: &[CommandMeta] = &[
            $( CommandMeta {
                name: $name,
                auth: $auth,
                desktop_only: $desktop,
                binary: $binary,
            } ),*
        ];

        /// headless 服务端的命令分发入口。
        pub async fn dispatch(
            name: &str,
            args: Value,
            ctx: &CommandContext,
        ) -> Result<CommandOutput, String> {
            $(
                if name == $name {
                    if $desktop {
                        return Err(format!("命令 {} 仅桌面端可用", $name));
                    }
                    let a: $args = parse_args(args)?;
                    let out = run_command($run, ctx, a).await?;
                    return out.into_output();
                }
            )*
            Err(format!("未知命令: {name}"))
        }
    };
}

use super::acp::acp_commands;
use super::app::app_commands;
use super::channels::channels_commands;
use super::db::db_commands;
use super::fs::fs_commands;
use super::git::git_commands;
use super::llm::llm_commands;
use super::markets::markets_commands;
use super::office::office_commands;
use super::rag::rag_commands;
use super::sys::sys_commands;

// 领域链入口：顺序**只此一处**决定 `COMMANDS`/`dispatch` 的行序。
// 各领域文件只负责把自己那批命令行追加进来。
sys_commands! { [acp_commands llm_commands rag_commands office_commands markets_commands channels_commands fs_commands git_commands db_commands app_commands command_table] }
