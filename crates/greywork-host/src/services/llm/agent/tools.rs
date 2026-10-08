//! 本机 agent 回合的工具面：只读三件套（读文件 / 列目录 / 最近提交）。
//!
//! 设计约束：
//! - **只读，且全部复用 `WorkspaceFsAccess`**。这是本模块唯一的安全支点：工具执行
//!   走的是与 `fs_read_text_file` / `git_log` 命令**同一个**授权面，不存在第二套
//!   allow-list。越界路径由 `resolve_existing` 直接拒掉，模型拿到的就是一条错误文本。
//! - 只读工具在三档权限里都是自动放行（对齐 `acp_host::is_readonly_kind` 的语义），
//!   所以 agent 回合无需交互式确认 —— 这也是把循环放在宿主侧而非渲染端的前提。
//! - 输出**有预算**。模型上下文是有限资源，无上限地把文件灌进去会让长回合在第三轮
//!   就撑爆；截断必须对模型可见（显式标注省略了多少），否则它会以为自己读全了。
//!
//! 工具名与 ACP 侧刻意不同（`read_file` / `list_dir` / `git_log` 而非 `fs_read_text_file`）：
//! ACP 那边是宿主命令名，这边要进模型提示词，短名对模型的调用命中率更高。

use serde_json::Value;

use crate::workspace_fs::WorkspaceFsAccess;

/// 单次工具输出送进模型上下文的字符上限。
///
/// 定位是「够模型看懂一个文件、又不会一轮灌爆」：源码文件按 12k 字符 ≈ 3-4k token，
/// 一次并行调三个工具也还在多数模型的窗口内。
pub(super) const MAX_TOOL_OUTPUT_CHARS: usize = 12_000;

/// `git_log` 默认返回条数。
const DEFAULT_GIT_LOG_LIMIT: u32 = 20;

/// 目录列举的条目数上限：单目录几千个文件时全量塞进上下文没有意义。
const MAX_DIR_ENTRIES: usize = 200;

/// 工具的 openai function schema（`tools` 数组元素形状）。
///
/// `strict` 不设：openai 的 strict 模式要求每个参数都在 `required` 里且禁用可选参数，
/// 这三条工具的 `path` 都需要「可省略走默认根」，与 strict 冲突。
pub(super) fn tool_schemas() -> Vec<Value> {
    vec![
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "读取工作区内一个文本文件的全文。用于查看源码、配置、文档。路径相对于工作区根，也可给绝对路径。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "文件路径，相对工作区根或绝对路径。必须是文本文件。"
                        }
                    },
                    "required": ["path"]
                }
            }
        }),
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": "列出工作区内一个目录的直接子项（文件与子目录）。用于先摸清结构再决定读哪个文件。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "目录路径，省略时列工作区根目录。"
                        }
                    },
                    "required": []
                }
            }
        }),
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "git_log",
                "description": "读取工作区的最近提交历史（哈希、作者、时间、标题）。用于了解近期改了什么。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": {
                            "type": "integer",
                            "description": "返回条数，默认 20。"
                        }
                    },
                    "required": []
                }
            }
        }),
    ]
}

/// 一次工具执行的结果。
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ToolOutput {
    /// 回给模型的文本（成功是结果，失败是错误说明 —— 两者都要回填，让模型能自我纠正）。
    pub(crate) content: String,
    /// 失败原因（`Some` 时前端把这次工具标成 failed）。
    pub(crate) error: Option<String>,
    /// 供事件/UI 用的简短摘要（文件路径、目录、条数）。
    pub(crate) summary: String,
    /// 展示用路径（前端时间线的 `path` 字段）。
    pub(crate) path: Option<String>,
}

impl ToolOutput {
    fn ok(content: String, summary: String, path: Option<String>) -> Self {
        Self {
            content,
            error: None,
            summary,
            path,
        }
    }

    fn failed(error: String, path: Option<String>) -> Self {
        // 失败时给模型的话要能指导下一步：说明是授权拒绝还是别的失败。
        Self {
            content: format!("工具执行失败：{error}"),
            error: Some(error),
            summary: "执行失败".into(),
            path,
        }
    }
}

/// 按字符截断并**显式标注**省略了多少。
///
/// 对模型可见的省略标注是必须的：静默截断会让它以为自己读到了完整文件，
/// 然后基于残缺内容给出自信的错误结论 —— 这比直接报错更坏。
fn clamp_output(value: String) -> String {
    if value.chars().count() <= MAX_TOOL_OUTPUT_CHARS {
        return value;
    }
    let total = value.chars().count();
    let kept: String = value.chars().take(MAX_TOOL_OUTPUT_CHARS).collect();
    format!(
        "{kept}\n\n[已截断：共 {total} 字符，只保留前 {MAX_TOOL_OUTPUT_CHARS} 字符。需要更多内容请用更小的范围重读]"
    )
}

/// 从参数里取字符串字段；缺字段或类型不对 → 一条给模型看的错误。
fn arg_str(input: &Value, key: &str) -> Result<String, String> {
    match input.get(key) {
        Some(Value::String(text)) if !text.trim().is_empty() => Ok(text.clone()),
        Some(Value::String(_)) => Err(format!("参数 `{key}` 是空字符串，请给出实际路径")),
        Some(_) => Err(format!("参数 `{key}` 必须是字符串")),
        None => Err(format!("缺少参数 `{key}`")),
    }
}

/// 把模型给的路径锚成绝对路径：相对的挂在工作区根下，原样保留绝对的。
///
/// 这一层必须有，因为模型最自然的输入是 `src/app.rs`（相对工作区根），而
/// `resolve_existing` 只接受绝对路径 —— 不锚定的话每次相对路径调用都会变成一轮白跑：
/// 模型拿到「只接受绝对路径」，得再猜一轮根在哪才能重发。
///
/// `..` 不在这里拦：锚定后的路径照样过 `resolve_existing`，它在 `canonicalize`
/// **之后**才判授权，所以 `../../etc/passwd` 解到 `/etc/passwd` 后照样被拒。放在这里
/// 拦反而会漏掉符号链接与 Windows 的 verbatim 前缀。
fn anchor_to_root(access: &WorkspaceFsAccess, raw: &str) -> String {
    let path = std::path::Path::new(raw);
    if path.is_absolute() {
        return raw.to_string();
    }
    access
        .default_root()
        .join(path)
        .to_string_lossy()
        .into_owned()
}

/// 可选的正整数参数（`limit`）。
fn optional_limit(input: &Value) -> Result<Option<u32>, String> {
    match input.get("limit") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_u64()
            .filter(|value| *value > 0)
            .map(|value| Some(value.min(u32::MAX as u64) as u32))
            .ok_or_else(|| "参数 `limit` 必须是正整数".to_string()),
        Some(_) => Err("参数 `limit` 必须是正整数".to_string()),
    }
}

/// 执行一次工具调用。
///
/// 未知工具名返回一条错误而不是 panic：模型（尤其小模型）经常编造工具名，
/// 让它收到「没有这个工具，可用工具是 …」后重试，比崩掉整个回合有用得多。
pub(super) fn execute(access: &WorkspaceFsAccess, name: &str, input: &Value) -> ToolOutput {
    match name {
        "read_file" => read_file(access, input),
        "list_dir" => list_dir(access, input),
        "git_log" => git_log(access, input),
        "" => ToolOutput::failed("这次调用没有工具名（name 为空），请重新发起并指明要用哪个工具".into(), None),
        other => ToolOutput::failed(
            format!(
                "没有名为 `{other}` 的工具。可用工具：read_file（读文本文件）、list_dir（列目录）、git_log（最近提交）"
            ),
            None,
        ),
    }
}

fn read_file(access: &WorkspaceFsAccess, input: &Value) -> ToolOutput {
    let raw = match arg_str(input, "path") {
        Ok(path) => path,
        Err(error) => return ToolOutput::failed(error, None),
    };
    let path = anchor_to_root(access, &raw);
    match crate::workspace_fs::fs_read_text_file(access, path.clone()) {
        Ok(text) => {
            let summary = format!("读取 {}（{} 字符）", path, text.chars().count());
            ToolOutput::ok(clamp_output(text), summary, Some(path))
        }
        // 授权拒绝与「文件不存在」在这里是同一条错误通路 —— 这是有意的：
        // 对未授权路径回一句「路径未授权」等于给模型一份「哪些路径在授权面外」的地图，
        // 反而帮它把试探范围收窄到面内。`fs_read_text_file` 的措辞也不区分二者。
        Err(error) => ToolOutput::failed(error, Some(path)),
    }
}

fn list_dir(access: &WorkspaceFsAccess, input: &Value) -> ToolOutput {
    // path 可省略 → 列工作区根。用 default_root 而不是让模型必须猜绝对路径：
    // 「有哪些文件」是最常见的开局动作，不该为它设置一次路径失败。
    let path = match input.get("path") {
        None | Some(Value::Null) => access.default_root().to_string_lossy().to_string(),
        Some(_) => match arg_str(input, "path") {
            Ok(raw) => anchor_to_root(access, &raw),
            Err(error) => return ToolOutput::failed(error, None),
        },
    };
    match crate::workspace_fs::fs_list_dir(access, path.clone()) {
        Ok(entries) => {
            let total = entries.len();
            let shown = entries.len().min(MAX_DIR_ENTRIES);
            let mut text = String::new();
            for entry in entries.iter().take(shown) {
                // 目录带尾斜杠：模型据此区分「这是个能进去的目录」还是「同名文件」。
                if entry.kind == "directory" {
                    text.push_str(&format!("{}/\n", entry.name));
                } else {
                    text.push_str(&format!("{}\n", entry.name));
                }
            }
            if total > shown {
                text.push_str(&format!(
                    "\n[已截断：共 {total} 项，只列前 {shown} 项。缩小 path 再看剩余部分]"
                ));
            }
            let summary = format!("列出 {path}（{total} 项）");
            ToolOutput::ok(text, summary, Some(path))
        }
        Err(error) => ToolOutput::failed(error, Some(path)),
    }
}

fn git_log(access: &WorkspaceFsAccess, input: &Value) -> ToolOutput {
    let limit = match optional_limit(input) {
        Ok(limit) => limit.unwrap_or(DEFAULT_GIT_LOG_LIMIT),
        Err(error) => return ToolOutput::failed(error, None),
    };
    let root = access.default_root().to_string_lossy().to_string();
    match crate::git::git_log(access, root.clone(), Some(limit), None) {
        // git 对「非仓库」与「空仓库」都回空列表，两种情况在协议层无法区分 ——
        // 措辞就同时覆盖，少一次「所以到底为什么是空的」追问。
        Ok(commits) if commits.is_empty() => ToolOutput::ok(
            "这个工作区没有提交历史（可能不是 git 仓库，或仓库还没有任何提交）。".to_string(),
            "读取提交历史（空）".into(),
            Some(root),
        ),
        Ok(commits) => {
            let mut text = String::new();
            for commit in &commits {
                // 一行一提交：哈希 / 相对时间 / 作者 / 主题。refs 带上是因为「这条提交在哪个
                // 分支上」常常就是模型要找的那条线索（`HEAD -> main`）。
                let refs = if commit.refs.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", commit.refs)
                };
                text.push_str(&format!(
                    "{} {}{} {} — {}\n",
                    commit.short_hash, commit.timestamp, refs, commit.author, commit.subject
                ));
            }
            let summary = format!("读取最近 {} 条提交（{} 条）", limit, commits.len());
            ToolOutput::ok(text, summary, Some(root))
        }
        Err(error) => ToolOutput::failed(error, Some(root)),
    }
}
