//! 命令注册表：桌面 `generate_handler!` 与 headless 服务端 `dispatch` 的唯一对齐基准。
//!
//! 桌面壳仍用 Tauri 的 `generate_handler!`（它要求每个命令是具体的 `fn`，无法内省），
//! 这里另存一份**元数据表** [`COMMANDS`] 与一个**分发入口** [`dispatch`]，服务端用它把
//! HTTP/WS 请求路由到共享实现。两者会不会漂移由桌面壳里的漂移测试兜住 —— 它把
//! `generate_handler!` 的命令名集合与本表逐一比对。
//!
//! 设计要点：
//! - **不构造 `CommandContext` 的桌面端**：本表只为服务端提供分发；桌面端只是把同一批
//!   `#[tauri::command]` 薄包装注册进 Tauri。`CommandContext` 里的 `Arc<T>` 是给服务端
//!   在启动期建一次、跨请求复用的。
//! - **桌面专属命令**（`desktop_only`）也列进表里（漂移测试要对齐），但 `dispatch` 一律
//!   返回明确错误 —— 原生文件对话框、系统托盘、系统浏览器这类能力 headless 没有对应物。
//! - **binary 命令**返回原始字节（`CommandOutput::Binary`），服务端包成 HTTP body；
//!   桌面端包成 `tauri::ipc::Response`。
//! - 入参结构体散在**所属领域模块**（`git::RootArg` 等），与前端扁平入参 camelCase 对齐。

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

/// `channel_send_media` 的服务端分发：按通道名取对应 host，交给该通道的上传实现。
///
/// 桌面壳里有等价的一份（用 `app.state::<XHost>()`）。刻意写两遍 —— 换来不必把
/// 7 个 host 全改成 `Arc`（见阶段 2 的设计记录）。
async fn channel_send_media(
    ctx: &CommandContext,
    args: channel_media::SendMediaArgs,
) -> Result<(), String> {
    let media = channel_media::prepare_outbound(
        &ctx.workspace,
        &args.channel,
        &args.path,
        args.kind.as_deref(),
    )?;
    match args.channel.as_str() {
        "wechat" => {
            wechat::send_media_impl(
                &ctx.host,
                &ctx.wechat,
                &args.peer_id,
                args.context_token.as_deref(),
                media,
            )
            .await
        }
        "telegram" => {
            telegram::send_media_impl(&ctx.host, &ctx.telegram, &args.peer_id, media).await
        }
        "discord" => discord::send_media_impl(&ctx.host, &ctx.discord, &args.peer_id, media).await,
        "feishu" => feishu::send_media_impl(&ctx.host, &ctx.feishu, &args.peer_id, media).await,
        "qq" => qq::send_media_impl(&ctx.host, &ctx.qq, &args.peer_id, media).await,
        "wecom" => wecom::send_media_impl(&ctx.host, &ctx.wecom, &args.peer_id, media).await,
        other => Err(format!("未知通道: {other}")),
    }
}

/// 命令表宏：一次声明同时生成 [`COMMANDS`] 与 [`dispatch`]。
///
/// 每条命令一行，`run` 闭包返回 `Result<Json<T>, String>`（JSON 命令）或
/// `Result<Bin, String>`（binary 命令）。`desktop: true` 的条目其 `run` 不会被调用
/// （`dispatch` 在解析入参前就返回），但仍需语法合法。
macro_rules! command_table {
    ($(
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

command_table! {
    // ---- sys ----
    // `sys_info` 的实现本就是宿主无关的（见 `sys` 模块头注释），宿主侧事实走
    // `ctx.host_facts` 注入 —— 服务端调用时 `tray_available` 为 false、版本是服务端自己的。
    // 桌面壳另有一份 `#[tauri::command]` 薄包装（apps/desktop/src-tauri/src/sys.rs）。
    { "sys_info", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { sys::sys_info(&ctx.db, &ctx.acp, &ctx.host_facts).await.map(Json) } }
    { "reveal_path", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }
    { "open_path", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }

    // ---- close_guard（桌面专属） ----
    { "set_unsaved_changes", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }
    { "confirm_exit", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }

    // ---- browser（桌面专属） ----
    // 内嵌浏览器是主窗口里的 child webview（需 cargo `unstable` feature），
    // headless 服务端没有对应物；实现全在 apps/desktop/src-tauri/src/browser.rs。
    { "browser_open", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }
    { "browser_set_bounds", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }
    { "browser_set_visible", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }
    { "browser_navigate", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }
    { "browser_back", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }
    { "browser_forward", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }
    { "browser_reload", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }
    { "browser_stop", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }
    { "browser_close", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }

    // ---- acp_host ----
    { "acp_permission_respond", auth: Auth::Required, desktop: false, binary: false,
        args: acp_host::PermissionRespondArgs,
        run: |ctx, a| async move { acp_host::acp_permission_respond(&ctx.acp, a.request_id, a.option_id).await.map(Json) } }
    { "acp_start", auth: Auth::Required, desktop: false, binary: false,
        args: acp_host::StartArgs,
        run: |ctx, a| async move { acp_host::acp_start(Arc::clone(&ctx.host), &ctx.acp, &ctx.agent_programs, &ctx.workspace, a.agent_cmd, a.tier, a.sandbox, a.workspace, a.env).await.map(Json) } }
    { "acp_new_session", auth: Auth::Required, desktop: false, binary: false,
        args: acp_host::NewSessionArgs,
        run: |ctx, a| async move { acp_host::acp_new_session(Arc::clone(&ctx.host), &ctx.acp, a.handle, a.cwd, a.mcp_servers).await.map(Json) } }
    { "acp_load_session", auth: Auth::Required, desktop: false, binary: false,
        args: acp_host::LoadSessionArgs,
        run: |ctx, a| async move { acp_host::acp_load_session(Arc::clone(&ctx.host), &ctx.acp, a.handle, a.cwd, a.session_id, a.mcp_servers).await.map(Json) } }
    { "acp_send", auth: Auth::Required, desktop: false, binary: false,
        args: acp_host::SendArgs,
        run: |ctx, a| async move { acp_host::acp_send(Arc::clone(&ctx.host), &ctx.acp, a.handle, a.text, a.units).await.map(Json) } }
    { "acp_set_config", auth: Auth::Required, desktop: false, binary: false,
        args: acp_host::SetConfigArgs,
        run: |ctx, a| async move { acp_host::acp_set_config(&ctx.acp, a.handle, a.config_id, a.value).await.map(Json) } }
    { "acp_stop", auth: Auth::Required, desktop: false, binary: false,
        args: acp_host::StopArgs,
        run: |ctx, a| async move { acp_host::acp_stop(Arc::clone(&ctx.host), &ctx.acp, a.handle, a.turn_id).await.map(Json) } }
    { "acp_set_permission_tier", auth: Auth::Required, desktop: false, binary: false,
        args: acp_host::SetPermissionTierArgs,
        run: |ctx, a| async move { acp_host::acp_set_permission_tier(&ctx.acp, a.handle, a.tier).await.map(Json) } }
    { "acp_list", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs, run: |ctx, _a| async move { acp_host::acp_list(&ctx.acp).await.map(Json) } }
    { "acp_detect_programs", auth: Auth::Required, desktop: false, binary: false,
        args: acp_host::DetectProgramsArgs,
        run: |_ctx, a| async move { Ok::<_, String>(Json(acp_host::acp_detect_programs(a.programs))) } }

    // ---- llm ----
    { "llm_chat_start", auth: Auth::Required, desktop: false, binary: false,
        args: llm::ChatStartArgs,
        run: |ctx, a| async move { llm::llm_chat_start(Arc::clone(&ctx.host), &ctx.llm, a.base_url, a.model, a.api_key_env, a.messages, a.reasoning_effort, a.headers, llm::InferenceParams { temperature: a.temperature, max_tokens: a.max_tokens }, a.client_token).await.map(Json) } }
    { "llm_chat_stop", auth: Auth::Required, desktop: false, binary: false,
        args: llm::ChatStopArgs,
        run: |ctx, a| async move { llm::llm_chat_stop(&ctx.llm, a.request_id).await.map(Json) } }
    // 模型清单（连通性自检）/ 向量 / 语音转写：本地 OpenAI 兼容服务提供。
    { "llm_list_models", auth: Auth::Required, desktop: false, binary: false,
        args: llm::ListModelsArgs,
        run: |_ctx, a| async move { llm::llm_list_models(a).await.map(Json) } }
    { "llm_embed", auth: Auth::Required, desktop: false, binary: false,
        args: llm::EmbedArgs,
        run: |_ctx, a| async move { llm::llm_embed(a).await.map(Json) } }
    { "llm_transcribe", auth: Auth::Required, desktop: false, binary: false,
        args: llm::TranscribeArgs,
        run: |ctx, a| async move { llm::llm_transcribe(&ctx.workspace, a).await.map(Json) } }

    // ---- rag（本地向量检索：授权工作区 → 本地 embedding → SQLite → 暴力余弦） ----
    { "rag_index_build", auth: Auth::Required, desktop: false, binary: false,
        args: rag::IndexBuildArgs,
        run: |ctx, a| async move { rag::rag_index_build(ctx.host.as_ref(), &ctx.workspace, &ctx.db, &ctx.rag, a).await.map(Json) } }
    { "rag_search", auth: Auth::Required, desktop: false, binary: false,
        args: rag::SearchArgs,
        run: |ctx, a| async move { rag::rag_search(&ctx.db, &ctx.rag, a).await.map(Json) } }
    { "rag_status", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { rag::rag_status(&ctx.db).map(Json) } }
    { "rag_clear", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { rag::rag_clear(&ctx.db, &ctx.rag).map(Json) } }

    // ---- office（第三方云端 Office 预览） ----
    // `office` 本身无状态（配方随调用传入，凭证每次从环境变量解析），与 LlmHost / WecomHost
    // 那种「持有连接与请求句柄」的不同；`office_host_info` 读 `ctx.frame_origins` 只是为了
    // 把宿主自己的 CSP 白名单如实回给渲染端（桌面与服务端各是一份真值）。
    { "office_host_info", auth: Auth::Required, desktop: false, binary: false,
        args: office::HostInfoArgs,
        run: |ctx, a| async move { Ok::<_, String>(Json(office::host_info(&ctx.frame_origins, a))) } }
    { "office_preview_open", auth: Auth::Required, desktop: false, binary: false,
        args: office::PreviewOpenArgs,
        run: |ctx, a| async move { office::open_preview(&ctx.workspace, a).await.map(Json) } }

    // ---- mcp ----
    { "mcp_probe", auth: Auth::Required, desktop: false, binary: false,
        args: mcp::ProbeArgs,
        run: |_ctx, a| async move { mcp::mcp_probe(a.transport, a.url, a.command, a.args, a.env, a.headers, a.timeout_secs).await.map(Json) } }

    // ---- skills_market ----
    { "skills_search", auth: Auth::Required, desktop: false, binary: false,
        args: skills_market::SearchArgs,
        run: |_ctx, a| async move { skills_market::skills_search(a.origin, a.query).await.map(Json) } }
    { "skills_download", auth: Auth::Required, desktop: false, binary: false,
        args: skills_market::DownloadArgs,
        run: |_ctx, a| async move { skills_market::skills_download(a.origin, a.entry_ref).await.map(Json) } }
    { "skills_install", auth: Auth::Required, desktop: false, binary: false,
        args: skills_market::InstallArgs,
        run: |_ctx, a| async move { skills_market::skills_install(a.workspace_root, a.skill_id, a.files).await.map(Json) } }
    { "skills_uninstall", auth: Auth::Required, desktop: false, binary: false,
        args: skills_market::UninstallArgs,
        run: |_ctx, a| async move { skills_market::skills_uninstall(a.workspace_root, a.skill_id).await.map(Json) } }
    // 内置技能（内容编译进二进制，不联网）：列出 + 安装。
    { "skills_bundled_list", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |_ctx, _a| async move { Ok::<_, String>(Json(bundled_skills::skills_bundled_list())) } }
    { "skills_install_bundled", auth: Auth::Required, desktop: false, binary: false,
        args: bundled_skills::InstallBundledArgs,
        run: |_ctx, a| async move { bundled_skills::skills_install_bundled(a.workspace_root, a.skill_id).map(Json) } }

    // ---- plugin_market ----
    { "plugin_market_catalog", auth: Auth::Required, desktop: false, binary: false,
        args: plugin_market::CatalogArgs,
        run: |_ctx, a| async move { plugin_market::plugin_market_catalog(a.registry_url).await.map(Json) } }
    { "plugin_market_install", auth: Auth::Required, desktop: false, binary: false,
        args: plugin_market::InstallArgs,
        run: |ctx, a| async move { plugin_market::plugin_market_install(ctx.host.as_ref(), a.registry_url, a.plugin_id).await.map(Json) } }
    { "plugin_market_list_installed", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { Ok::<_, String>(Json(plugin_market::plugin_market_list_installed(ctx.host.as_ref()))) } }
    { "plugin_market_uninstall", auth: Auth::Required, desktop: false, binary: false,
        args: plugin_market::UninstallArgs,
        run: |ctx, a| async move { plugin_market::plugin_market_uninstall(ctx.host.as_ref(), a.plugin_id).map(Json) } }
    { "plugin_net_fetch", auth: Auth::Required, desktop: false, binary: false,
        args: plugin_market::PluginFetchRequest,
        run: |_ctx, a| async move { plugin_market::plugin_net_fetch(a).await.map(Json) } }
    { "plugin_market_preview", auth: Auth::Required, desktop: false, binary: false,
        args: plugin_market::PreviewArgs,
        run: |_ctx, a| async move { plugin_market::plugin_market_preview(a.registry_url, a.plugin_id).await.map(Json) } }

    // ---- plugin_window（桌面专属） ----
    { "plugin_window_open", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }
    { "plugin_window_close", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }

    // ---- mcp_registry ----
    { "mcp_search", auth: Auth::Required, desktop: false, binary: false,
        args: mcp_registry::SearchArgs,
        run: |_ctx, a| async move { mcp_registry::mcp_search(a.search, a.limit).await.map(Json) } }

    // ---- web_fetch ----
    { "web_fetch", auth: Auth::Required, desktop: false, binary: false,
        args: web_fetch::WebFetchRequest,
        run: |_ctx, a| async move { web_fetch::web_fetch(a).await.map(Json) } }

    // ---- wechat ----
    { "wechat_status", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { wechat::wechat_status(Arc::clone(&ctx.host), &ctx.wechat).await.map(Json) } }
    { "wechat_login_qr", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { wechat::wechat_login_qr(Arc::clone(&ctx.host), &ctx.wechat).await.map(Json) } }
    { "wechat_login_poll", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { wechat::wechat_login_poll(Arc::clone(&ctx.host), &ctx.wechat).await.map(Json) } }
    { "wechat_login_cancel", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { wechat::wechat_login_cancel(&ctx.wechat).await.map(Json) } }
    { "wechat_connect", auth: Auth::Required, desktop: false, binary: false,
        args: ConnectArgs,
        run: |ctx, a| async move { wechat::wechat_connect(Arc::clone(&ctx.host), &ctx.wechat, a.allow_other_senders).await.map(Json) } }
    { "wechat_disconnect", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { wechat::wechat_disconnect(Arc::clone(&ctx.host), &ctx.wechat).await.map(Json) } }
    { "wechat_logout", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { wechat::wechat_logout(Arc::clone(&ctx.host), &ctx.wechat).await.map(Json) } }
    { "wechat_send", auth: Auth::Required, desktop: false, binary: false,
        args: wechat::SendArgs,
        run: |ctx, a| async move { wechat::wechat_send(Arc::clone(&ctx.host), &ctx.wechat, a.to_user_id, a.context_token, a.text).await.map(Json) } }
    { "wechat_send_typing", auth: Auth::Required, desktop: false, binary: false,
        args: wechat::SendTypingArgs,
        run: |ctx, a| async move { wechat::wechat_send_typing(Arc::clone(&ctx.host), &ctx.wechat, a.to_user_id, a.typing).await.map(Json) } }

    // ---- channel_media ----
    { "channel_take_media", auth: Auth::Required, desktop: false, binary: true,
        args: channel_media::TakeMediaArgs,
        run: |ctx, a| async move { channel_media::channel_take_media(ctx.host.as_ref(), a.channel, a.path).map(Bin) } }
    { "channel_send_media", auth: Auth::Required, desktop: false, binary: false,
        args: channel_media::SendMediaArgs,
        run: |ctx, a| async move { channel_send_media(ctx, a).await.map(Json) } }
    { "channel_media_capabilities", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |_ctx, _a| async move { Ok::<_, String>(Json(channel_media::channel_media_capabilities())) } }

    // ---- dingtalk ----
    { "dingtalk_status", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { dingtalk::dingtalk_status(Arc::clone(&ctx.host), &ctx.dingtalk).await.map(Json) } }
    { "dingtalk_save_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: ClientSecretArg,
        run: |ctx, a| async move { dingtalk::dingtalk_save_credentials(Arc::clone(&ctx.host), &ctx.dingtalk, a.client_id, a.client_secret).await.map(Json) } }
    { "dingtalk_clear_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { dingtalk::dingtalk_clear_credentials(Arc::clone(&ctx.host), &ctx.dingtalk).await.map(Json) } }
    { "dingtalk_register_begin", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { dingtalk::dingtalk_register_begin(&ctx.dingtalk).await.map(Json) } }
    { "dingtalk_register_poll", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { dingtalk::dingtalk_register_poll(Arc::clone(&ctx.host), &ctx.dingtalk).await.map(Json) } }
    { "dingtalk_register_cancel", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { dingtalk::dingtalk_register_cancel(&ctx.dingtalk).await.map(Json) } }
    { "dingtalk_connect", auth: Auth::Required, desktop: false, binary: false,
        args: ConnectArgs,
        run: |ctx, a| async move { dingtalk::dingtalk_connect(Arc::clone(&ctx.host), &ctx.dingtalk, a.allow_other_senders).await.map(Json) } }
    { "dingtalk_disconnect", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { dingtalk::dingtalk_disconnect(Arc::clone(&ctx.host), &ctx.dingtalk).await.map(Json) } }
    { "dingtalk_send", auth: Auth::Required, desktop: false, binary: false,
        args: PeerTextArgs,
        run: |ctx, a| async move { dingtalk::dingtalk_send(Arc::clone(&ctx.host), &ctx.dingtalk, a.peer_id, a.text).await.map(Json) } }

    // ---- feishu ----
    { "feishu_status", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { feishu::feishu_status(Arc::clone(&ctx.host), &ctx.feishu).await.map(Json) } }
    { "feishu_save_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: AppSecretArg,
        run: |ctx, a| async move { feishu::feishu_save_credentials(Arc::clone(&ctx.host), &ctx.feishu, a.app_id, a.app_secret).await.map(Json) } }
    { "feishu_clear_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { feishu::feishu_clear_credentials(Arc::clone(&ctx.host), &ctx.feishu).await.map(Json) } }
    { "feishu_register_begin", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { feishu::feishu_register_begin(&ctx.feishu).await.map(Json) } }
    { "feishu_register_poll", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { feishu::feishu_register_poll(Arc::clone(&ctx.host), &ctx.feishu).await.map(Json) } }
    { "feishu_register_cancel", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { feishu::feishu_register_cancel(&ctx.feishu).await.map(Json) } }
    { "feishu_connect", auth: Auth::Required, desktop: false, binary: false,
        args: ConnectArgs,
        run: |ctx, a| async move { feishu::feishu_connect(Arc::clone(&ctx.host), &ctx.feishu, a.allow_other_senders).await.map(Json) } }
    { "feishu_disconnect", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { feishu::feishu_disconnect(Arc::clone(&ctx.host), &ctx.feishu).await.map(Json) } }
    { "feishu_send", auth: Auth::Required, desktop: false, binary: false,
        args: PeerTextArgs,
        run: |ctx, a| async move { feishu::feishu_send(Arc::clone(&ctx.host), &ctx.feishu, a.peer_id, a.text).await.map(Json) } }

    // ---- telegram ----
    { "telegram_status", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { telegram::telegram_status(Arc::clone(&ctx.host), &ctx.telegram).await.map(Json) } }
    { "telegram_save_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: TokenArg,
        run: |ctx, a| async move { telegram::telegram_save_credentials(Arc::clone(&ctx.host), &ctx.telegram, a.token).await.map(Json) } }
    { "telegram_clear_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { telegram::telegram_clear_credentials(Arc::clone(&ctx.host), &ctx.telegram).await.map(Json) } }
    { "telegram_connect", auth: Auth::Required, desktop: false, binary: false,
        args: ConnectArgs,
        run: |ctx, a| async move { telegram::telegram_connect(Arc::clone(&ctx.host), &ctx.telegram, a.allow_other_senders).await.map(Json) } }
    { "telegram_disconnect", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { telegram::telegram_disconnect(Arc::clone(&ctx.host), &ctx.telegram).await.map(Json) } }
    { "telegram_send", auth: Auth::Required, desktop: false, binary: false,
        args: PeerTextArgs,
        run: |ctx, a| async move { telegram::telegram_send(Arc::clone(&ctx.host), &ctx.telegram, a.peer_id, a.text).await.map(Json) } }
    { "telegram_bot_link", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { telegram::telegram_bot_link(Arc::clone(&ctx.host), &ctx.telegram).await.map(Json) } }

    // ---- discord ----
    { "discord_status", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { discord::discord_status(Arc::clone(&ctx.host), &ctx.discord).await.map(Json) } }
    { "discord_save_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: TokenArg,
        run: |ctx, a| async move { discord::discord_save_credentials(Arc::clone(&ctx.host), &ctx.discord, a.token).await.map(Json) } }
    { "discord_clear_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { discord::discord_clear_credentials(Arc::clone(&ctx.host), &ctx.discord).await.map(Json) } }
    { "discord_connect", auth: Auth::Required, desktop: false, binary: false,
        args: ConnectArgs,
        run: |ctx, a| async move { discord::discord_connect(Arc::clone(&ctx.host), &ctx.discord, a.allow_other_senders).await.map(Json) } }
    { "discord_disconnect", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { discord::discord_disconnect(Arc::clone(&ctx.host), &ctx.discord).await.map(Json) } }
    { "discord_send", auth: Auth::Required, desktop: false, binary: false,
        args: PeerTextArgs,
        run: |ctx, a| async move { discord::discord_send(Arc::clone(&ctx.host), &ctx.discord, a.peer_id, a.text).await.map(Json) } }

    // ---- qq ----
    { "qq_status", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { qq::qq_status(Arc::clone(&ctx.host), &ctx.qq).await.map(Json) } }
    { "qq_save_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: AppSecretArg,
        run: |ctx, a| async move { qq::qq_save_credentials(Arc::clone(&ctx.host), &ctx.qq, a.app_id, a.app_secret).await.map(Json) } }
    { "qq_register_begin", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { qq::qq_register_begin(&ctx.qq).await.map(Json) } }
    { "qq_register_poll", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { qq::qq_register_poll(Arc::clone(&ctx.host), &ctx.qq).await.map(Json) } }
    { "qq_register_cancel", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { qq::qq_register_cancel(&ctx.qq).await.map(Json) } }
    { "qq_clear_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { qq::qq_clear_credentials(Arc::clone(&ctx.host), &ctx.qq).await.map(Json) } }
    { "qq_connect", auth: Auth::Required, desktop: false, binary: false,
        args: ConnectArgs,
        run: |ctx, a| async move { qq::qq_connect(Arc::clone(&ctx.host), &ctx.qq, a.allow_other_senders).await.map(Json) } }
    { "qq_disconnect", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { qq::qq_disconnect(Arc::clone(&ctx.host), &ctx.qq).await.map(Json) } }
    { "qq_send", auth: Auth::Required, desktop: false, binary: false,
        args: PeerTextArgs,
        run: |ctx, a| async move { qq::qq_send(Arc::clone(&ctx.host), &ctx.qq, a.peer_id, a.text).await.map(Json) } }

    // ---- wecom ----
    { "wecom_status", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { wecom::wecom_status(Arc::clone(&ctx.host), &ctx.wecom).await.map(Json) } }
    { "wecom_save_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: BotSecretArg,
        run: |ctx, a| async move { wecom::wecom_save_credentials(Arc::clone(&ctx.host), &ctx.wecom, a.bot_id, a.secret).await.map(Json) } }
    { "wecom_clear_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { wecom::wecom_clear_credentials(Arc::clone(&ctx.host), &ctx.wecom).await.map(Json) } }
    { "wecom_connect", auth: Auth::Required, desktop: false, binary: false,
        args: ConnectArgs,
        run: |ctx, a| async move { wecom::wecom_connect(Arc::clone(&ctx.host), &ctx.wecom, a.allow_other_senders).await.map(Json) } }
    { "wecom_disconnect", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { wecom::wecom_disconnect(Arc::clone(&ctx.host), &ctx.wecom).await.map(Json) } }
    { "wecom_send", auth: Auth::Required, desktop: false, binary: false,
        args: PeerTextArgs,
        run: |ctx, a| async move { wecom::wecom_send(Arc::clone(&ctx.host), &ctx.wecom, a.peer_id, a.text).await.map(Json) } }

    // ---- workspace_fs ----
    { "fs_read_text_file", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::PathArg,
        run: |ctx, a| async move { workspace_fs::fs_read_text_file(&ctx.workspace, a.path).map(Json) } }
    { "fs_read_binary", auth: Auth::Required, desktop: false, binary: true,
        args: workspace_fs::PathArg,
        run: |ctx, a| async move { workspace_fs::fs_read_binary(&ctx.workspace, a.path).map(Bin) } }
    { "fs_read_media", auth: Auth::Required, desktop: false, binary: true,
        args: workspace_fs::MediaArg,
        run: |ctx, a| async move { workspace_fs::fs_read_media(&ctx.workspace, a.path, a.max_bytes).map(Bin) } }
    { "fs_probe_file", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::PathArg,
        run: |ctx, a| async move { workspace_fs::fs_probe_file(&ctx.workspace, a.path).map(Json) } }
    { "fs_write_text_file", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::WriteTextArg,
        run: |ctx, a| async move { workspace_fs::fs_write_text_file(&ctx.workspace, a.path, a.content).map(Json) } }
    { "fs_write_binary", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::WriteBinaryArg,
        run: |ctx, a| async move { workspace_fs::fs_write_binary(&ctx.workspace, a.path, a.data_base64).map(Json) } }
    { "fs_ensure_dir", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::PathArg,
        run: |ctx, a| async move { workspace_fs::fs_ensure_dir(&ctx.workspace, a.path).map(Json) } }
    { "fs_create_file", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::PathArg,
        run: |ctx, a| async move { workspace_fs::fs_create_file(&ctx.workspace, a.path).map(Json) } }
    { "fs_create_dir", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::PathArg,
        run: |ctx, a| async move { workspace_fs::fs_create_dir(&ctx.workspace, a.path).map(Json) } }
    { "fs_rename_path", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::TransferArg,
        run: |ctx, a| async move { workspace_fs::fs_rename_path(&ctx.workspace, a.from, a.to).map(Json) } }
    { "fs_copy_path", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::TransferArg,
        run: |ctx, a| async move { workspace_fs::fs_copy_path(&ctx.workspace, a.from, a.to).map(Json) } }
    { "fs_delete_path", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::PathArg,
        run: |ctx, a| async move { workspace_fs::fs_delete_path(&ctx.workspace, a.path).map(Json) } }
    { "fs_list_dir", auth: Auth::Required, desktop: false, binary: false,
        args: workspace_fs::PathArg,
        run: |ctx, a| async move { workspace_fs::fs_list_dir(&ctx.workspace, a.path).map(Json) } }
    { "fs_pick_files", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }

    // ---- sheet ----
    { "fs_read_sheet", auth: Auth::Required, desktop: false, binary: false,
        args: sheet::ReadSheetArgs,
        run: |ctx, a| async move { sheet::fs_read_sheet(&ctx.workspace, a.path, a.sheet, a.max_rows).map(Json) } }

    // ---- git ----
    { "git_status", auth: Auth::Required, desktop: false, binary: false,
        args: git::RootArg,
        run: |ctx, a| async move { git::git_status(&ctx.workspace, a.root).map(Json) } }
    { "git_changes", auth: Auth::Required, desktop: false, binary: false,
        args: git::RootArg,
        run: |ctx, a| async move { git::git_changes(&ctx.workspace, a.root).map(Json) } }
    { "git_diff", auth: Auth::Required, desktop: false, binary: false,
        args: git::DiffArgs,
        run: |ctx, a| async move { git::git_diff(&ctx.workspace, a.root, a.path, a.staged).map(Json) } }
    { "git_stage", auth: Auth::Required, desktop: false, binary: false,
        args: git::StageArgs,
        run: |ctx, a| async move { git::git_stage(&ctx.workspace, a.root, a.paths, a.all).map(Json) } }
    { "git_unstage", auth: Auth::Required, desktop: false, binary: false,
        args: git::StageArgs,
        run: |ctx, a| async move { git::git_unstage(&ctx.workspace, a.root, a.paths, a.all).map(Json) } }
    { "git_commit", auth: Auth::Required, desktop: false, binary: false,
        args: git::CommitArgs,
        run: |ctx, a| async move { git::git_commit(&ctx.workspace, a.root, a.message, a.all).map(Json) } }
    { "git_current_branch", auth: Auth::Required, desktop: false, binary: false,
        args: git::RootArg,
        run: |ctx, a| async move { git::git_current_branch(&ctx.workspace, a.root).map(Json) } }
    { "git_branch_list", auth: Auth::Required, desktop: false, binary: false,
        args: git::RootArg,
        run: |ctx, a| async move { git::git_branch_list(&ctx.workspace, a.root).map(Json) } }
    { "git_log", auth: Auth::Required, desktop: false, binary: false,
        args: git::LogArgs,
        run: |ctx, a| async move { git::git_log(&ctx.workspace, a.root, a.limit, a.skip).map(Json) } }
    { "git_show", auth: Auth::Required, desktop: false, binary: false,
        args: git::ShowArgs,
        run: |ctx, a| async move { git::git_show(&ctx.workspace, a.root, a.hash, a.path).map(Json) } }

    // ---- store_fs ----
    { "store_sessions_load", auth: Auth::Required, desktop: false, binary: false,
        args: store_fs::SessionsLoadArgs,
        run: |ctx, a| async move { store_fs::store_sessions_load(ctx.host.as_ref(), &ctx.db, &ctx.workspace, a.workspaces).map(Json) } }
    { "store_sessions_sync", auth: Auth::Required, desktop: false, binary: false,
        args: store_fs::SessionsSyncArgs,
        run: |ctx, a| async move { store_fs::store_sessions_sync(ctx.host.as_ref(), &ctx.workspace, a.snapshot, a.workspaces, a.deleted_session_ids).map(Json) } }
    { "store_default_root", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { store_fs::store_default_root(ctx.host.as_ref()).map(Json) } }
    { "attachments_prune_session", auth: Auth::Required, desktop: false, binary: false,
        args: store_fs::PruneSessionArgs,
        run: |ctx, a| async move { store_fs::attachments_prune_session(ctx.host.as_ref(), a.session_id).map(Json) } }
    { "store_sessions_relocate", auth: Auth::Required, desktop: false, binary: false,
        args: store_fs::RelocateRequestDto,
        run: |ctx, a| async move { store_fs::store_sessions_relocate(ctx.host.as_ref(), &ctx.workspace, a).map(Json) } }
    { "pick_workspace_folder", auth: Auth::Required, desktop: true, binary: false,
        args: UnitArgs, run: |_ctx, _a| async move { Err::<Json<()>, String>("仅桌面端可用".into()) } }

    // ---- worktree ----
    { "worktree_provision", auth: Auth::Required, desktop: false, binary: false,
        args: worktree::ProvisionArgs,
        run: |ctx, a| async move { worktree::worktree_provision(ctx.host.as_ref(), &ctx.workspace, a.source).map(Json) } }
    { "worktree_release", auth: Auth::Required, desktop: false, binary: false,
        args: worktree::ReleaseArgs,
        run: |ctx, a| async move { worktree::worktree_release(ctx.host.as_ref(), &ctx.workspace, a.root).map(Json) } }
    { "worktree_list", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { worktree::worktree_list(ctx.host.as_ref()).map(Json) } }

    // ---- db ----
    { "db_settings_load", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs, run: |ctx, _a| async move { db::db_settings_load(&ctx.db).map(Json) } }
    { "db_settings_sync", auth: Auth::Required, desktop: false, binary: false,
        args: db::SettingsSyncArgs,
        run: |ctx, a| async move { db::db_settings_sync(&ctx.db, a.settings).map(Json) } }
    { "db_automations_load", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs, run: |ctx, _a| async move { db::db_automations_load(&ctx.db).map(Json) } }
    { "db_automations_sync", auth: Auth::Required, desktop: false, binary: false,
        args: db::AutomationsSyncArgs,
        run: |ctx, a| async move { db::db_automations_sync(&ctx.db, a.tasks).map(Json) } }
    { "db_automations_due_list", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs, run: |ctx, _a| async move { db::db_automations_due_list(&ctx.db).map(Json) } }
    { "db_automations_due_finish", auth: Auth::Required, desktop: false, binary: false,
        args: db::DueFinishArgs,
        run: |ctx, a| async move { db::db_automations_due_finish(&ctx.db, a.id, a.status).map(Json) } }
    { "db_automation_runs_load", auth: Auth::Required, desktop: false, binary: false,
        args: db::RunsLoadArgs,
        run: |ctx, a| async move { db::db_automation_runs_load(&ctx.db, a.limit).map(Json) } }
    { "db_automation_run_record", auth: Auth::Required, desktop: false, binary: false,
        args: db::RunRecordArgs,
        run: |ctx, a| async move { db::db_automation_run_record(&ctx.db, a.run).map(Json) } }
    { "db_team_runs_load", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs, run: |ctx, _a| async move { db::db_team_runs_load(&ctx.db).map(Json) } }
    { "db_team_runs_sync", auth: Auth::Required, desktop: false, binary: false,
        args: db::TeamRunsSyncArgs,
        run: |ctx, a| async move { db::db_team_runs_sync(&ctx.db, a.runs).map(Json) } }
    { "db_agents_load", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs, run: |ctx, _a| async move { db::db_agents_load(&ctx.db).map(Json) } }
    { "db_agents_sync", auth: Auth::Required, desktop: false, binary: false,
        args: db::AgentsSyncArgs,
        run: |ctx, a| async move { db::db_agents_sync(&ctx.db, a.providers).map(Json) } }

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::HostPaths;
    use std::path::Path;

    /// headless 侧的桩宿主：只提供路径，事件/通知丢弃。
    struct StubHost {
        paths: HostPaths,
    }

    impl HostContext for StubHost {
        fn paths(&self) -> &HostPaths {
            &self.paths
        }
        fn emit(&self, _event: &str, _payload: Value) {}
        fn notify(&self, _title: &str, _body: &str) {}
    }

    fn test_ctx(tmp: &Path) -> CommandContext {
        let data_dir = tmp.join("data");
        let root = tmp.join("root");
        std::fs::create_dir_all(&data_dir).expect("mkdir data");
        std::fs::create_dir_all(&root).expect("mkdir root");
        let host: Arc<dyn HostContext> = Arc::new(StubHost {
            paths: HostPaths::new(tmp.join("home"), data_dir),
        });
        CommandContext {
            host,
            db: Arc::new(Db::open_in_memory().expect("db")),
            workspace: Arc::new(
                WorkspaceFsAccess::new(&root, tmp.join("access.json")).expect("access"),
            ),
            acp: Arc::new(AcpHost::default()),
            llm: Arc::new(LlmHost::default()),
            rag: Arc::new(RagHost::default()),
            wechat: Arc::new(WechatHost::default()),
            dingtalk: Arc::new(DingTalkHost::default()),
            feishu: Arc::new(FeishuHost::default()),
            telegram: Arc::new(TelegramHost::default()),
            discord: Arc::new(DiscordHost::default()),
            qq: Arc::new(QqHost::default()),
            wecom: Arc::new(WecomHost::default()),
            // 空列表 = 只放行内置白名单（headless 语义）。
            agent_programs: Arc::new(Vec::new()),
            // 非空样例：既覆盖「宿主白名单被如实回给渲染端」，也让下面的冒烟断言有东西可断。
            frame_origins: Arc::new(vec!["https://docs.example.com".to_string()]),
            host_facts: sys::HostFacts {
                version: "9.9.9-test".to_string(),
                tray_available: false,
                pinned_sandbox: true,
                pinned_tier: Some("read-only".to_string()),
            },
        }
    }

    /// 桌面专属命令集合（与计划表一致；漂移测试的另一半在桌面壳）。
    const DESKTOP_ONLY: &[&str] = &[
        "browser_back",
        "browser_close",
        "browser_forward",
        "browser_navigate",
        "browser_open",
        "browser_reload",
        "browser_set_bounds",
        "browser_set_visible",
        "browser_stop",
        "reveal_path",
        "open_path",
        "set_unsaved_changes",
        "confirm_exit",
        "plugin_window_open",
        "plugin_window_close",
        "fs_pick_files",
        "pick_workspace_folder",
        "set_close_to_tray",
        "set_tray_labels",
        "close_main_window",
        "open_external",
    ];

    #[test]
    fn commands_table_shape() {
        assert_eq!(COMMANDS.len(), 161, "命令总数应为 161");

        // 命令名唯一。
        let mut names: Vec<&str> = COMMANDS.iter().map(|c| c.name).collect();
        names.sort_unstable();
        let unique = {
            let mut n = names.clone();
            n.dedup();
            n.len()
        };
        assert_eq!(unique, names.len(), "命令名必须唯一");

        // 桌面专属集合与计划一致。
        let mut desktop_only: Vec<&str> = COMMANDS
            .iter()
            .filter(|c| c.desktop_only)
            .map(|c| c.name)
            .collect();
        desktop_only.sort_unstable();
        let mut expected = DESKTOP_ONLY.to_vec();
        expected.sort_unstable();
        assert_eq!(desktop_only, expected, "桌面专属集合必须与计划一致");

        // binary 命令恰 3 条。
        let mut binary: Vec<&str> = COMMANDS
            .iter()
            .filter(|c| c.binary)
            .map(|c| c.name)
            .collect();
        binary.sort_unstable();
        assert_eq!(
            binary,
            vec!["channel_take_media", "fs_read_binary", "fs_read_media"]
        );

        // 桌面专属与 binary 不相交。
        assert!(COMMANDS.iter().all(|c| !(c.desktop_only && c.binary)));
    }

    #[tokio::test]
    async fn dispatch_smoke_db_settings_load() {
        let tmp = std::env::temp_dir().join(format!("gw-cmd-smoke-{}", std::process::id()));
        let ctx = test_ctx(&tmp);

        // 端到端：零参命令 + null 载荷。
        let out = dispatch("db_settings_load", Value::Null, &ctx)
            .await
            .expect("dispatch db_settings_load");
        assert!(matches!(out, CommandOutput::Json(Value::Null)));

        // 桌面专属命令明确拒绝。
        let error = dispatch("reveal_path", Value::Null, &ctx)
            .await
            .expect_err("reveal_path 应被拒绝");
        assert!(error.contains("仅桌面端可用"), "实际错误：{error}");

        // sys_info 走得通：宿主侧事实从 ctx 注入，如实回传（服务端不再谎报）。
        let out = dispatch("sys_info", Value::Null, &ctx)
            .await
            .expect("dispatch sys_info");
        let CommandOutput::Json(value) = out else {
            panic!("sys_info 应返回 JSON");
        };
        assert_eq!(value["version"], "9.9.9-test");
        assert_eq!(value["trayAvailable"], serde_json::json!(false));
        assert_eq!(value["pinnedSandbox"], serde_json::json!(true));
        assert_eq!(value["pinnedTier"], serde_json::json!("read-only"));

        // 未知命令。
        assert!(dispatch("no_such_command", Value::Null, &ctx)
            .await
            .is_err());

        // office：零参形态的宿主事实查询经 dispatch 走得通（`office_preview_open`
        // 的端到端在 office.rs 里，那需要真起一个 HTTP 服务）。
        let out = dispatch(
            "office_host_info",
            serde_json::json!({ "envNames": ["GREYWORK_TEST_OFFICE_ABSENT3"] }),
            &ctx,
        )
        .await
        .expect("dispatch office_host_info");
        let CommandOutput::Json(value) = out else {
            panic!("office_host_info 应返回 JSON");
        };
        assert_eq!(
            value["envMissing"],
            serde_json::json!(["GREYWORK_TEST_OFFICE_ABSENT3"])
        );
        // 回的是注入给 ctx 的那份白名单，不是桌面常量 —— 服务端不再谎报。
        assert_eq!(
            value["embeddableFrameOrigins"],
            serde_json::json!(["https://docs.example.com"])
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
