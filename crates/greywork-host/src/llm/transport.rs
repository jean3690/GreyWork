//! 端点拼接、鉴权与请求构造（chat/completions 与各端点共用的助手）。

use std::collections::HashMap;

use super::dto::{InferenceParams, LlmChatMessage};
/// 拼接 openai 兼容端点：baseUrl 已带版本段（/v1、/v4…）则直接追加，
/// 否则补默认 /v1。兼容 OpenAI / DeepSeek / Moonshot / 智谱 / vLLM / Ollama(/v1) 等。
pub(super) fn endpoint_url(base_url: &str, path: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let last_segment = trimmed.rsplit('/').next().unwrap_or("");
    let has_version = last_segment.len() >= 2
        && last_segment.starts_with('v')
        && last_segment[1..].chars().all(|c| c.is_ascii_digit());
    if has_version {
        format!("{trimmed}/{path}")
    } else {
        format!("{trimmed}/v1/{path}")
    }
}

pub(super) fn completions_url(base_url: &str) -> String {
    endpoint_url(base_url, "chat/completions")
}

/// 推理等级 → openai `reasoning_effort`。auto/空/未知不传；max 收敛为 high（openai 无 max 档）。
pub(super) fn openai_reasoning_effort(effort: &str) -> Option<&'static str> {
    match effort.trim().to_ascii_lowercase().as_str() {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "max" => Some("high"),
        _ => None,
    }
}

/// 构造流式请求体。推理档位映射为 openai `reasoning_effort`，
/// 仅对显式档位（low/medium/high/max）添加，避免不支持的模型拒绝整个请求。
pub(super) fn chat_request_body(
    model: &str,
    messages: Vec<LlmChatMessage>,
    reasoning_effort: &str,
    params: &InferenceParams,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "stream": true,
        "messages": messages
            .into_iter()
            .map(|message| serde_json::json!({
                "role": message.role,
                "content": message.content,
            }))
            .collect::<Vec<_>>(),
    });
    if let Some(effort) = openai_reasoning_effort(reasoning_effort) {
        body["reasoning_effort"] = serde_json::json!(effort);
    }
    if let Some(temperature) = params.temperature {
        body["temperature"] = serde_json::json!(temperature);
    }
    if let Some(max_tokens) = params.max_tokens {
        body["max_tokens"] = serde_json::json!(max_tokens);
    }
    body
}

/// 解析请求头值中的 `{{ENV_VAR}}` 占位符为环境变量实际值。
/// 变量未设置/为空 → Err（指路用户补环境变量），绝不静默丢头——带占位符原样发出
/// 等于把密钥模板发给远端。
///
/// `pub(crate)`：`office.rs` 的配方请求头用同一套占位符语义，共用一份实现
/// （两处各写一遍迟早会在「未闭合 `{{` 怎么处理」这类边角上分叉）。
pub(crate) fn resolve_header_placeholders(value: &str) -> Result<String, String> {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) => {
                let name = after[..end].trim();
                match std::env::var(name) {
                    Ok(resolved) if !resolved.is_empty() => out.push_str(&resolved),
                    _ => {
                        return Err(format!(
                            "未设置环境变量 {name}：请求头占位符 {{{{{name}}}}} 无法解析，请先 export 后从同一终端启动 GreyWork（或到设置页修改该请求头）"
                        ));
                    }
                }
                rest = &after[end + 2..];
            }
            None => {
                // 只有 {{ 没有 }}：按字面量保留，交给 reqwest/服务端判定合法性
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    Ok(out)
}

/// 解析 API Key（环境变量名 → 值）。声明了 env 却没设值 → Err 指路用户去哪补；
/// env 名为空（本地服务如 Ollama）才允许匿名。
pub(super) fn resolve_api_key(api_key_env: &str) -> Result<String, String> {
    let env_name = api_key_env.trim();
    if env_name.is_empty() {
        return Ok(String::new());
    }
    match std::env::var(env_name) {
        Ok(value) if !value.is_empty() => Ok(value),
        _ => Err(format!(
            "未设置 API Key：先在本机终端执行 {}，再从同一终端启动 GreyWork（设置页 → Agent → 模型供应商可查看/修改变量名）",
            env_set_hint(env_name, cfg!(windows))
        )),
    }
}

/// 给请求挂上 bearer 鉴权与自定义头（`{{ENV}}` 占位符宿主侧解析）。
pub(super) fn apply_auth(
    mut request: reqwest::RequestBuilder,
    api_key: &str,
    headers: &HashMap<String, String>,
) -> Result<reqwest::RequestBuilder, String> {
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    for (key, value) in headers {
        let resolved = resolve_header_placeholders(value)?;
        request = request.header(key, resolved);
    }
    Ok(request)
}

/// 构造并发送 chat/completions 请求（command 与宿主自主执行共用）。
pub(super) async fn send_chat_request(
    base_url: &str,
    model: &str,
    api_key_env: &str,
    messages: Vec<LlmChatMessage>,
    reasoning_effort: &str,
    headers: &HashMap<String, String>,
    params: &InferenceParams,
) -> Result<reqwest::Response, String> {
    let api_key = resolve_api_key(api_key_env)?;
    let client = crate::http::shared_client(10)?;
    let request = client
        .post(completions_url(base_url))
        .json(&chat_request_body(
            model.trim(),
            messages,
            reasoning_effort,
            params,
        ));
    let request = apply_auth(request, &api_key, headers)?;
    let response = request
        .send()
        .await
        .map_err(|error| format!("llm request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = crate::http::read_text(response, crate::http::RESPONSE_READ_TIMEOUT)
            .await
            .unwrap_or_default();
        return Err(format!(
            "llm endpoint returned {status}: {}（检查 API Key 是否有效，或到设置页 → Agent → 模型供应商核对 Base URL / 模型名）",
            truncate(&body, 200)
        ));
    }
    Ok(response)
}

/// 设置环境变量在当前平台的写法。
///
/// 写死 `export` 会让 Windows 用户照做后仍然失败（cmd 用 `set`、PowerShell 用 `$env:`）。
/// 参数化平台是为了能在 Linux CI 上把三种写法都钉住。
/// `pub(crate)`：`office.rs` 的凭证未设置提示复用同一句，免得两个模块给出两种引导。
pub(crate) fn env_set_hint(env_name: &str, windows: bool) -> String {
    if windows {
        format!("set {env_name}=你的密钥（PowerShell 用 $env:{env_name}=\"你的密钥\"）")
    } else {
        format!("export {env_name}=你的密钥")
    }
}

/// 响应是否为 SSE 流（Content-Type 判定）。
pub(super) fn is_sse_response(response: &reqwest::Response) -> bool {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("event-stream"))
}

/// 按字符（不是字节）截断，附省略号。错误体诊断用。
/// `pub(crate)`：`office.rs` 的上传失败诊断复用（按字节截会切坏中文错误体）。
pub(crate) fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let cut: String = value.chars().take(max_chars).collect();
    format!("{cut}…")
}
