//! manifest 与包的整体校验（能力、区域、窗口声明）。

use super::dto::{
    CapabilityRequirement, DeclarativeField, DeclarativeOperation, ManifestMcpServerRef,
    ManifestScheduleKind, MarketPluginManifest, PluginKind,
};
use super::validate::{
    validate_dir_key, validate_fields, validate_github_url, validate_key, validate_page,
    validate_sha256, validate_version,
};
use super::{MAX_PLUGIN_FETCH_BYTES_CEILING, MIN_PLUGIN_FETCH_BYTES};

/// 插件设置项条数上界：设置中心是一页表单，不该被单个插件刷满。
const MAX_PLUGIN_SETTINGS_FIELDS: usize = 16;

/// 右键菜单条目数上界。
const MAX_PLUGIN_CONTEXT_MENUS: usize = 8;
/// 右键菜单文案长度上界（一行菜单项的宽度）。
const CONTEXT_LABEL_MAX_CHARS: usize = 40;
/// 允许挂载右键菜单的区域（宿主已实现的三处）。
const CONTEXT_MENU_TARGETS: [&str; 3] = ["fileTree", "preview", "conversation"];

/// 命令面板条目数上界：一个插件的快捷动作不该把 ⌘K 刷成一页。
const MAX_PLUGIN_COMMANDS: usize = 16;
/// 命令标题长度上界（面板一行的展示宽度）。
const COMMAND_TITLE_MAX_CHARS: usize = 60;
/// 命令说明长度上界。
const COMMAND_DESCRIPTION_MAX_CHARS: usize = 120;

/// 悬浮窗标题长度上界（与设置页 / 任务栏的展示宽度相当）。
const WINDOW_TITLE_MAX_CHARS: usize = 64;
/// 悬浮窗不透明度下界：再低就只剩一团影子，用户会以为窗口丢了。
const WINDOW_OPACITY_MIN: f32 = 0.2;

/// schedule 间隔下界（分钟）：5 分钟，防高频空转。
const SCHEDULE_MIN_MIN: u32 = 5;
/// schedule 间隔上界（分钟）：24 小时。
const SCHEDULE_MAX_MIN: u32 = 24 * 60;

/// llm.chat 模型白名单条数上界。
const LLM_CHAT_MAX_MODELS: usize = 8;

/// mcp.connect 服务器条目上界：插件不该把整个 MCP 市场都据为己有。
const MCP_CONNECT_MAX_SERVERS: usize = 4;
/// mcp.connect 单台服务器的工具白名单条数上界。
const MCP_CONNECT_MAX_TOOLS: usize = 16;
/// 服务器名长度上界（与设置页展示宽度相当）。
const MCP_CONNECT_MAX_SERVER_NAME_LEN: usize = 64;
/// 工具名长度上界（与宿主 mcp::mcp_call 的 MAX_TOOL_NAME_CHARS 一致）。
const MCP_CONNECT_MAX_TOOL_LEN: usize = 128;
/// llm.chat 单个模型 id 长度上界。
const LLM_CHAT_MAX_MODEL_LEN: usize = 128;

/// net.fetch 允许声明的 HTTP 方法全集（缺省子集为 GET/HEAD）。
const NET_FETCH_ALLOWED_METHODS: [&str; 3] = ["GET", "HEAD", "POST"];
/// net.fetch `paths` 模板条数上界（仅 POST 需要）。
const NET_FETCH_MAX_PATHS: usize = 8;
/// net.fetch 单个路径模板长度上界。
const NET_FETCH_MAX_PATH_LEN: usize = 128;

pub(super) fn validate_requirement(requirement: &CapabilityRequirement) -> Result<(), String> {
    match requirement {
        CapabilityRequirement::Plain(capability) => {
            validate_key(capability, "required capability")?;
            match capability.as_str() {
                "net.fetch" => Err("net.fetch requires a host allowlist: use { \"capability\": \"net.fetch\", \"hosts\": [...] }".to_string()),
                "schedule" => Err("schedule requires an interval: use { \"capability\": \"schedule\", \"schedule\": { \"kind\": \"interval\", \"min\": 60 } }".to_string()),
                "llm.chat" => Err("llm.chat requires a model allowlist: use { \"capability\": \"llm.chat\", \"models\": [\"gpt-4o-mini\"] }".to_string()),
                "mcp.connect" => Err("mcp.connect requires a server allowlist: use { \"capability\": \"mcp.connect\", \"servers\": [{ \"name\": \"fs\", \"tools\": [\"read_file\"] }] }".to_string()),
                _ => Ok(()),
            }
        }
        CapabilityRequirement::Parameterized {
            capability,
            hosts,
            methods,
            paths,
            max_bytes,
            schedule,
            models,
            ops,
            servers,
        } => {
            validate_key(capability, "required capability")?;
            match capability.as_str() {
                "net.fetch" => {
                    if schedule.is_some() {
                        return Err("net.fetch does not accept schedule parameters".to_string());
                    }
                    if !models.is_empty() {
                        return Err(
                            "net.fetch does not accept models; use the models of llm.chat"
                                .to_string(),
                        );
                    }
                    if !ops.is_empty() {
                        return Err(
                            "net.fetch does not accept ops; use the ops of clipboard".to_string()
                        );
                    }
                    if !servers.is_empty() {
                        return Err(
                            "net.fetch does not accept servers; use the servers of mcp.connect"
                                .to_string(),
                        );
                    }
                    validate_net_fetch_params(hosts, methods, paths, *max_bytes)?;
                    Ok(())
                }
                "llm.chat" => {
                    if !hosts.is_empty() || !methods.is_empty() || !paths.is_empty() {
                        return Err(
                            "llm.chat does not accept net.fetch parameters (hosts/methods/paths)"
                                .to_string(),
                        );
                    }
                    if max_bytes.is_some() || schedule.is_some() {
                        return Err(
                            "llm.chat does not accept maxBytes / schedule parameters".to_string()
                        );
                    }
                    if !ops.is_empty() {
                        return Err("llm.chat does not accept ops".to_string());
                    }
                    if !servers.is_empty() {
                        return Err(
                            "llm.chat does not accept servers; use the servers of mcp.connect"
                                .to_string(),
                        );
                    }
                    validate_llm_chat_models(models)
                }
                "clipboard" => {
                    if !hosts.is_empty() || !methods.is_empty() || !paths.is_empty() {
                        return Err(
                            "clipboard does not accept net.fetch parameters (hosts/methods/paths)"
                                .to_string(),
                        );
                    }
                    if max_bytes.is_some() || schedule.is_some() || !models.is_empty() {
                        return Err(
                            "clipboard does not accept maxBytes / schedule / models parameters"
                                .to_string(),
                        );
                    }
                    if !servers.is_empty() {
                        return Err(
                            "clipboard does not accept servers; use the servers of mcp.connect"
                                .to_string(),
                        );
                    }
                    validate_clipboard_ops(ops)
                }
                "schedule" => {
                    if !hosts.is_empty() {
                        return Err(
                            "schedule does not accept hosts; use schedule::interval parameters"
                                .to_string(),
                        );
                    }
                    if !methods.is_empty() || !paths.is_empty() || max_bytes.is_some() {
                        return Err(
                            "schedule does not accept net.fetch parameters (methods/paths/maxBytes)"
                                .to_string(),
                        );
                    }
                    if !models.is_empty() {
                        return Err("schedule does not accept models".to_string());
                    }
                    if !ops.is_empty() {
                        return Err("schedule does not accept ops".to_string());
                    }
                    if !servers.is_empty() {
                        return Err("schedule does not accept servers".to_string());
                    }
                    let Some(declared) = schedule else {
                        return Err("schedule requires schedule parameters: { \"kind\": \"interval\", \"min\": 60 }".to_string());
                    };
                    if declared.kind != ManifestScheduleKind::Interval {
                        return Err("schedule kind must be \"interval\"".to_string());
                    }
                    if !(SCHEDULE_MIN_MIN..=SCHEDULE_MAX_MIN).contains(&declared.min) {
                        return Err(format!(
                            "schedule interval must be between {SCHEDULE_MIN_MIN} and {SCHEDULE_MAX_MIN} minutes"
                        ));
                    }
                    Ok(())
                }
                "mcp.connect" => {
                    if !hosts.is_empty() || !methods.is_empty() || !paths.is_empty() {
                        return Err(
                            "mcp.connect does not accept net.fetch parameters (hosts/methods/paths)"
                                .to_string(),
                        );
                    }
                    if max_bytes.is_some() || schedule.is_some() {
                        return Err("mcp.connect does not accept maxBytes / schedule parameters"
                            .to_string());
                    }
                    if !models.is_empty() {
                        return Err("mcp.connect does not accept models".to_string());
                    }
                    if !ops.is_empty() {
                        return Err("mcp.connect does not accept ops".to_string());
                    }
                    validate_mcp_connect_servers(servers)
                }
                _ => Err(format!(
                    "capability {capability} does not accept parameters; use the plain string form"
                )),
            }
        }
    }
}

/// net.fetch 参数化声明校验：hosts 白名单 + 可选 methods / paths / maxBytes。
///
/// 语义（与前端 broker 同构；此处是安装期第一道门）：
/// - `methods` 缺省 = GET/HEAD；只能是 GET/HEAD/POST 的子集；
/// - 声明 `POST` 时必须给出 1-8 条路径模板（POST 只对这些模板开放），否则 `paths` 必须为空；
/// - `maxBytes` 在 1 KiB .. 8 MiB 之间（缺省 1 MiB）。
fn validate_net_fetch_params(
    hosts: &[String],
    methods: &[String],
    paths: &[String],
    max_bytes: Option<u32>,
) -> Result<(), String> {
    if hosts.is_empty() || hosts.len() > 16 {
        return Err("net.fetch hosts allowlist must contain 1-16 entries".to_string());
    }
    for host in hosts {
        validate_host(host)?;
    }
    let mut seen_methods = std::collections::HashSet::new();
    for method in methods {
        if !NET_FETCH_ALLOWED_METHODS.contains(&method.as_str()) {
            return Err(format!(
                "net.fetch method must be one of GET/HEAD/POST, got {method}"
            ));
        }
        if !seen_methods.insert(method.as_str()) {
            return Err(format!("net.fetch duplicate method: {method}"));
        }
    }
    let declares_post = methods.iter().any(|method| method == "POST");
    if declares_post {
        if paths.is_empty() || paths.len() > NET_FETCH_MAX_PATHS {
            return Err(format!(
                "net.fetch POST requires 1-{NET_FETCH_MAX_PATHS} path templates"
            ));
        }
        for path in paths {
            validate_path_template(path)?;
        }
    } else if !paths.is_empty() {
        return Err("net.fetch paths is only allowed when POST is declared".to_string());
    }
    if let Some(bytes) = max_bytes {
        if !(MIN_PLUGIN_FETCH_BYTES as u32..=MAX_PLUGIN_FETCH_BYTES_CEILING as u32).contains(&bytes)
        {
            return Err(format!(
                "net.fetch maxBytes must be between {MIN_PLUGIN_FETCH_BYTES} and {MAX_PLUGIN_FETCH_BYTES_CEILING}"
            ));
        }
    }
    Ok(())
}

/// 路径模板：以 `/` 开头、≤128 字符、仅 ASCII 安全字符 + `*` 通配（`*` 段内、`**` 跨段）。
fn validate_path_template(template: &str) -> Result<(), String> {
    if !template.starts_with('/') {
        return Err(format!(
            "net.fetch path template must start with '/': {template}"
        ));
    }
    if template.len() > NET_FETCH_MAX_PATH_LEN {
        return Err(format!(
            "net.fetch path template exceeds {NET_FETCH_MAX_PATH_LEN} characters"
        ));
    }
    if !template.chars().all(|c| {
        c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.' | '~' | '*' | '%' | ':')
    }) {
        return Err(format!(
            "net.fetch path template has invalid characters: {template}"
        ));
    }
    Ok(())
}

/// llm.chat 模型白名单校验（安装期第一道门；执行期由前端 broker 再校验一次）。
///
/// 语义：
/// - 必须声明 1-8 个模型 id（空声明等于「不限模型」，不允许）；
/// - 每个 id 非空、≤128 字符、不含空白 / 控制字符（模型 id 会原样进请求体）；
/// - 重复项拒绝（去重后的声明与用户授权时看到的一致）。
fn validate_llm_chat_models(models: &[String]) -> Result<(), String> {
    if models.is_empty() || models.len() > LLM_CHAT_MAX_MODELS {
        return Err(format!(
            "llm.chat models allowlist must contain 1-{LLM_CHAT_MAX_MODELS} entries"
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for model in models {
        let trimmed = model.trim();
        if trimmed.is_empty() {
            return Err("llm.chat model id must not be empty".to_string());
        }
        if model.len() > LLM_CHAT_MAX_MODEL_LEN {
            return Err(format!(
                "llm.chat model id exceeds {LLM_CHAT_MAX_MODEL_LEN} characters"
            ));
        }
        if model.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(format!("llm.chat model id has invalid characters: {model}"));
        }
        if !seen.insert(model.as_str()) {
            return Err(format!("duplicate model id in llm.chat allowlist: {model}"));
        }
    }
    Ok(())
}

/// clipboard 操作子集校验（安装期第一道门；执行期由前端 broker 再校验一次）。
///
/// 语义：
/// - 参数化声明必须给 1-2 条 `read` / `write`，不重复；
/// - **字符串形态等价于只允许 `write`** —— 读剪贴板是隐私面，必须显式声明。
fn validate_clipboard_ops(ops: &[String]) -> Result<(), String> {
    if ops.is_empty() || ops.len() > 2 {
        return Err("clipboard ops must contain 1-2 entries (read / write)".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    for op in ops {
        if op != "read" && op != "write" {
            return Err(format!(
                "unknown clipboard op: {op} (expected read / write)"
            ));
        }
        if !seen.insert(op.as_str()) {
            return Err(format!("duplicate clipboard op: {op}"));
        }
    }
    Ok(())
}

/// mcp.connect 声明校验（安装期第一道门；执行期由前端 broker 与宿主命令各再校验一次）。
///
/// 语义：
/// - 1-4 台服务器，**按名字引用用户已配置的服务器**（见 ManifestMcpServerRef）；
///   名字非空、≤64 字符、无控制字符 —— 名字是用户自己起的，允许中文，不按标识符收紧；
/// - 每台服务器必须显式给出 1-16 个工具名（空清单等于「授权全部工具」，一律拒绝）；
/// - 工具名非空、≤128 字符、无控制字符，同一服务器内不重复；服务器之间不重复。
fn validate_mcp_connect_servers(servers: &[ManifestMcpServerRef]) -> Result<(), String> {
    if servers.is_empty() || servers.len() > MCP_CONNECT_MAX_SERVERS {
        return Err(format!(
            "mcp.connect servers allowlist must contain 1-{MCP_CONNECT_MAX_SERVERS} entries"
        ));
    }
    let mut seen_servers = std::collections::HashSet::new();
    for server in servers {
        let name = server.name.trim();
        if name.is_empty() {
            return Err("mcp.connect server name must not be empty".to_string());
        }
        if name.chars().count() > MCP_CONNECT_MAX_SERVER_NAME_LEN {
            return Err(format!(
                "mcp.connect server name exceeds {MCP_CONNECT_MAX_SERVER_NAME_LEN} characters"
            ));
        }
        if name.chars().any(char::is_control) {
            return Err("mcp.connect server name must not contain control characters".to_string());
        }
        if !seen_servers.insert(name) {
            return Err(format!("duplicate server in mcp.connect allowlist: {name}"));
        }
        if server.tools.is_empty() || server.tools.len() > MCP_CONNECT_MAX_TOOLS {
            return Err(format!(
                "mcp.connect server {name} must declare 1-{MCP_CONNECT_MAX_TOOLS} tools"
            ));
        }
        let mut seen_tools = std::collections::HashSet::new();
        for tool in &server.tools {
            let trimmed = tool.trim();
            if trimmed.is_empty() {
                return Err(format!("mcp.connect tool name must not be empty ({name})"));
            }
            if trimmed.chars().count() > MCP_CONNECT_MAX_TOOL_LEN {
                return Err(format!(
                    "mcp.connect tool name exceeds {MCP_CONNECT_MAX_TOOL_LEN} characters ({name})"
                ));
            }
            if trimmed.chars().any(char::is_control) {
                return Err(format!(
                    "mcp.connect tool name must not contain control characters ({name})"
                ));
            }
            if !seen_tools.insert(trimmed) {
                return Err(format!(
                    "duplicate tool {trimmed} in mcp.connect allowlist ({name})"
                ));
            }
        }
    }
    Ok(())
}

/// 设置项校验：字段规则与页面字段完全同源（`validate_fields`），只多一个条数上限。
///
/// 值落在插件自己的 `storage.kv` 命名空间里，因此 key 的形态、默认值类型、数值边界都沿用
/// 页面字段的口径 —— 插件作者不需要学两套 schema。
fn validate_settings_schema(fields: &[DeclarativeField]) -> Result<(), String> {
    if fields.is_empty() {
        return Ok(());
    }
    if fields.len() > MAX_PLUGIN_SETTINGS_FIELDS {
        return Err(format!(
            "settingsSchema must contain at most {MAX_PLUGIN_SETTINGS_FIELDS} fields"
        ));
    }
    validate_fields("settings schema", fields)?;
    Ok(())
}

/// 右键菜单声明校验（安装期第一道门；冲突检测在前端 loader）。
///
/// 语义：
/// - 最多 8 条，id 走 validate_key、包内唯一；
/// - label 1-40 字符、无控制字符（会原样进菜单）；
/// - targets 必须落在宿主已实现的三个区域里，1-3 条且不重复 —— 宿主没实现的区域宁可
///   安装期拒掉，也不要让插件以为「点得到」；
/// - mode 必须指向本包声明过的页面（缺省取第一个），理由同 commands。
fn validate_context_menu(
    manifest: &MarketPluginManifest,
    mode_ids: &std::collections::HashSet<String>,
) -> Result<(), String> {
    let entries = &manifest.contributes.context_menu;
    if entries.len() > MAX_PLUGIN_CONTEXT_MENUS {
        return Err(format!(
            "contextMenu contribution must contain at most {MAX_PLUGIN_CONTEXT_MENUS} entries"
        ));
    }
    if !entries.is_empty() && manifest.contributes.modes.is_empty() {
        return Err("contextMenu contribution requires at least one mode to open".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    for entry in entries {
        validate_key(&entry.id, "context menu id")?;
        if !seen.insert(&entry.id) {
            return Err(format!(
                "duplicate context menu id in package: {}",
                entry.id
            ));
        }
        let label = entry.label.trim();
        if label.is_empty() {
            return Err(format!("contextMenu {} requires a label", entry.id));
        }
        if label.chars().count() > CONTEXT_LABEL_MAX_CHARS {
            return Err(format!(
                "contextMenu {} label exceeds {CONTEXT_LABEL_MAX_CHARS} characters",
                entry.id
            ));
        }
        if label.chars().any(char::is_control) {
            return Err(format!(
                "contextMenu {} label must not contain control characters",
                entry.id
            ));
        }
        if entry.targets.is_empty() || entry.targets.len() > CONTEXT_MENU_TARGETS.len() {
            return Err(format!(
                "contextMenu {} must declare 1-{} targets",
                entry.id,
                CONTEXT_MENU_TARGETS.len()
            ));
        }
        let mut seen_targets = std::collections::HashSet::new();
        for target in &entry.targets {
            if !CONTEXT_MENU_TARGETS.contains(&target.as_str()) {
                return Err(format!(
                    "contextMenu {} has unknown target: {target} (expected {})",
                    entry.id,
                    CONTEXT_MENU_TARGETS.join(" / ")
                ));
            }
            if !seen_targets.insert(target) {
                return Err(format!(
                    "duplicate target {target} in contextMenu {}",
                    entry.id
                ));
            }
        }
        if let Some(mode) = &entry.mode {
            if !mode_ids.contains(mode) {
                return Err(format!(
                    "contextMenu {} targets unknown mode: {mode}",
                    entry.id
                ));
            }
        }
    }
    Ok(())
}

/// 命令面板条目校验（安装期第一道门；跨包 id 冲突由前端 loader 的冲突检测再挡一次）。
///
/// 语义：
/// - 最多 16 条，id 走 validate_key、包内唯一；
/// - title 1-60 字符、description ≤120、都不含控制字符（会原样进 ⌘K 列表）；
/// - mode 必须指向本包声明过的 mode（缺省取第一个）—— 目标页不存在时，命令点下去只会得到
///   一条空白路由，这种「看起来能用其实不能」的声明要在安装期就拒掉。
fn validate_commands(
    manifest: &MarketPluginManifest,
    mode_ids: &std::collections::HashSet<String>,
) -> Result<(), String> {
    let commands = &manifest.contributes.commands;
    if commands.len() > MAX_PLUGIN_COMMANDS {
        return Err(format!(
            "commands contribution must contain at most {MAX_PLUGIN_COMMANDS} entries"
        ));
    }
    if !commands.is_empty() && manifest.contributes.modes.is_empty() {
        return Err("commands contribution requires at least one mode to open".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    for command in commands {
        validate_key(&command.id, "command id")?;
        if !seen.insert(&command.id) {
            return Err(format!("duplicate command id in package: {}", command.id));
        }
        let title = command.title.trim();
        if title.is_empty() {
            return Err(format!("command {} requires a title", command.id));
        }
        if title.chars().count() > COMMAND_TITLE_MAX_CHARS {
            return Err(format!(
                "command {} title exceeds {COMMAND_TITLE_MAX_CHARS} characters",
                command.id
            ));
        }
        if title.chars().any(char::is_control) {
            return Err(format!(
                "command {} title must not contain control characters",
                command.id
            ));
        }
        if let Some(description) = &command.description {
            if description.chars().count() > COMMAND_DESCRIPTION_MAX_CHARS {
                return Err(format!(
                    "command {} description exceeds {COMMAND_DESCRIPTION_MAX_CHARS} characters",
                    command.id
                ));
            }
            if description.chars().any(char::is_control) {
                return Err(format!(
                    "command {} description must not contain control characters",
                    command.id
                ));
            }
        }
        match &command.mode {
            Some(mode) if !mode_ids.contains(mode) => {
                return Err(format!(
                    "command {} targets unknown mode: {mode}",
                    command.id
                ))
            }
            None if manifest.contributes.modes.is_empty() => {
                return Err(format!(
                    "command {} requires a mode (the package declares none)",
                    command.id
                ))
            }
            _ => {}
        }
    }
    Ok(())
}

/// manifest 是否声明了 `window.floating` 能力。
///
/// 悬浮窗由宿主托管，但「能开窗」这件事必须在 manifest 里显式声明（用户据此知情授权）；
/// `validate_package` 强制 window 声明与 requires 一致，宿主开窗命令再以此做纵深校验。
pub fn declares_window_floating(manifest: &MarketPluginManifest) -> bool {
    manifest
        .requires
        .iter()
        .any(|requirement| match requirement {
            CapabilityRequirement::Plain(capability) => capability == "window.floating",
            CapabilityRequirement::Parameterized { capability, .. } => {
                capability == "window.floating"
            }
        })
}

fn validate_host(host: &str) -> Result<(), String> {
    let labels: Vec<&str> = host.split('.').collect();
    if host.len() > 253 || labels.len() < 2 {
        return Err(format!("invalid host in allowlist: {host}"));
    }
    for label in labels {
        if label.is_empty()
            || label.len() > 63
            || !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            || label.starts_with('-')
            || label.ends_with('-')
        {
            return Err(format!("invalid host in allowlist: {host}"));
        }
    }
    Ok(())
}

pub(super) fn validate_package(package: &super::dto::PluginPackage) -> Result<(), String> {
    if package.schema_version != 1 {
        return Err(format!(
            "unsupported package schema version: {}",
            package.schema_version
        ));
    }
    let manifest = &package.manifest;
    validate_dir_key(&manifest.id, "plugin id")?;
    if manifest.id.starts_with("core.") {
        return Err("plugin id prefix core. is reserved for built-in plugins".to_string());
    }
    validate_version(&manifest.version)?;
    if manifest.name.trim().is_empty() || manifest.name.len() > 120 {
        return Err("plugin name must contain 1-120 characters".to_string());
    }
    match (&manifest.kind, &manifest.runtime) {
        (PluginKind::Declarative, None) => {}
        (PluginKind::Worker, Some(runtime)) => {
            if runtime.runtime_type != "worker" {
                return Err("code plugin runtime type must be worker".to_string());
            }
            validate_github_url(&runtime.entry)?;
            validate_sha256(&runtime.sha256)?;
            if let Some(render) = &runtime.render {
                validate_key(&render.handler, "render handler")?;
                if let Some(fps) = render.fps {
                    if !(1..=60).contains(&fps) {
                        return Err(format!("render fps must be 1-60, got {fps}"));
                    }
                }
                for size in [render.width, render.height] {
                    if size.is_some_and(|value| value == 0 || value > 512) {
                        return Err("render canvas size must be 1-512 pixels".to_string());
                    }
                }
            }
        }
        (PluginKind::Declarative, Some(_)) => {
            return Err("declarative plugin must not define a runtime".to_string());
        }
        (PluginKind::Worker, None) => return Err("worker plugin requires a runtime".to_string()),
    }
    if manifest.contributes.modes.is_empty() || manifest.contributes.modes.len() > 8 {
        return Err("plugin must contribute 1-8 modes".to_string());
    }
    for required in &manifest.requires {
        validate_requirement(required)?;
    }
    let mut mode_ids = std::collections::HashSet::new();

    for mode in &manifest.contributes.modes {
        validate_key(&mode.id, "mode id")?;
        if mode.id == "plugins" {
            return Err("mode id plugins is reserved for the built-in plugin center".to_string());
        }
        if !mode_ids.insert(mode.id.clone()) {
            return Err(format!("duplicate mode id in package: {}", mode.id));
        }
        if mode.title.trim().is_empty() || mode.page.heading.trim().is_empty() {
            return Err(format!("mode {} requires title and page heading", mode.id));
        }
        if mode.title.len() > 120 {
            return Err(format!("mode {} title exceeds 120 characters", mode.id));
        }
        if mode.page.heading.len() > 160 {
            return Err(format!("mode {} heading exceeds 160 characters", mode.id));
        }
        if mode
            .page
            .eyebrow
            .as_deref()
            .is_some_and(|eyebrow| eyebrow.len() > 120)
        {
            return Err(format!("mode {} eyebrow exceeds 120 characters", mode.id));
        }
        if mode.page.body.len() > 16 * 1024 {
            return Err(format!("mode {} body is too large", mode.id));
        }
        validate_page(&mode.id, &mode.page)?;
        let has_invoke = mode
            .page
            .actions
            .iter()
            .any(|action| matches!(action.operation, DeclarativeOperation::Invoke { .. }));
        // invoke 动作要在 worker 里执行 —— 声明式包不得引用（拒绝而非静默忽略）。
        if has_invoke && manifest.kind != PluginKind::Worker {
            return Err("invoke actions require a worker plugin".to_string());
        }
    }
    validate_commands(manifest, &mode_ids)?;
    validate_context_menu(manifest, &mode_ids)?;
    validate_settings_schema(&manifest.contributes.settings_schema)?;

    if let Some(window) = &manifest.window {
        if manifest.kind != PluginKind::Worker
            || manifest
                .runtime
                .as_ref()
                .and_then(|runtime| runtime.render.as_ref())
                .is_none()
        {
            return Err(
                "window declaration requires a worker plugin with a render loop".to_string(),
            );
        }
        for size in [window.width, window.height] {
            if size == 0 || size > 512 {
                return Err("plugin window size must be 1-512 pixels".to_string());
            }
        }
        if let Some(title) = &window.title {
            let trimmed = title.trim();
            if trimmed.is_empty() {
                return Err("plugin window title must not be empty".to_string());
            }
            if trimmed.chars().count() > WINDOW_TITLE_MAX_CHARS {
                return Err(format!(
                    "plugin window title exceeds {WINDOW_TITLE_MAX_CHARS} characters"
                ));
            }
            if trimmed.chars().any(char::is_control) {
                return Err("plugin window title must not contain control characters".to_string());
            }
        }
        if let Some(opacity) = window.opacity {
            // NaN 也走这条：contains 对 NaN 恒为 false。
            if !(WINDOW_OPACITY_MIN..=1.0).contains(&opacity) {
                return Err(format!(
                    "plugin window opacity must be between {WINDOW_OPACITY_MIN} and 1.0"
                ));
            }
        }
        // 脱窗是受控能力：声明窗口就必须同时声明 window.floating（用户授权门禁的输入）。
        if !declares_window_floating(manifest) {
            return Err(
                "window declaration requires the window.floating capability in requires"
                    .to_string(),
            );
        }
    }
    validate_ui_regions(manifest)?;
    Ok(())
}

/// 区域贡献校验：仅 worker 包（需渲染循环驱动）、区域白名单、尺寸/标题/动作有界。
fn validate_ui_regions(manifest: &MarketPluginManifest) -> Result<(), String> {
    if manifest.contributes.ui_regions.is_empty() {
        return Ok(());
    }
    if manifest.kind != PluginKind::Worker {
        return Err("uiRegions contributions require a worker plugin".to_string());
    }
    if manifest
        .runtime
        .as_ref()
        .and_then(|runtime| runtime.render.as_ref())
        .is_none()
    {
        return Err("uiRegions contributions require a render loop (runtime.render)".to_string());
    }
    let mut region_ids = std::collections::HashSet::new();
    for region in &manifest.contributes.ui_regions {
        if !matches!(
            region.region.as_str(),
            "shellSidebar" | "activityPanel" | "workspaceOverlay"
        ) {
            return Err(format!(
                "uiRegion has unsupported host region: {}",
                region.region
            ));
        }
        validate_key(&region.id, "uiRegion id")?;
        if !region_ids.insert(&region.id) {
            return Err(format!("duplicate uiRegion id in package: {}", region.id));
        }
        if region.title.trim().is_empty() || region.title.len() > 80 {
            return Err(format!(
                "uiRegion {} requires a 1-80 character title",
                region.id
            ));
        }
        for size in [region.width, region.height] {
            if size.is_some_and(|value| value == 0 || value > 512) {
                return Err(format!(
                    "uiRegion {} canvas size must be 1-512 pixels",
                    region.id
                ));
            }
        }
        if region.actions.len() > 4 {
            return Err(format!("uiRegion {} exceeds 4 action buttons", region.id));
        }
        let mut action_ids = std::collections::HashSet::new();
        for action in &region.actions {
            validate_key(&action.id, "region action id")?;
            if action.label.trim().is_empty()
                || action.label.len() > 20
                || !action_ids.insert(&action.id)
            {
                return Err(format!(
                    "uiRegion {} has an invalid or duplicate action",
                    region.id
                ));
            }
        }
    }
    Ok(())
}
