//! 语音转写：`POST /audio/transcriptions`（OpenAI 兼容 multipart）。

use std::collections::HashMap;

use crate::core::ports::WorkspaceFs;

use super::dto::{TranscribeArgs, TranscribeResult};
use super::transport::{apply_auth, endpoint_url, resolve_api_key, truncate};

/// 语音转写的音频上限：与附件通用文件上限一致（`attachments.ts` 的 20MB）。
/// 转写要把整段音频读进内存再走 multipart，不设硬顶等于让一次调用分配任意大缓冲。
const TRANSCRIBE_MAX_BYTES: usize = 20 * 1024 * 1024;
/// 语音转写（`POST /audio/transcriptions`，OpenAI 兼容 multipart）。
/// 音频从**授权路径**读取 —— 附件落在 `~/.greyWork/attachments`，该根始终授权。
pub async fn llm_transcribe(
    workspace: &dyn WorkspaceFs,
    args: TranscribeArgs,
) -> Result<TranscribeResult, String> {
    let base_url = args.base_url.trim();
    if base_url.is_empty() {
        return Err("base_url is required".to_string());
    }
    let path = workspace.resolve_existing(&args.path)?;
    let bytes = std::fs::read(&path).map_err(|error| format!("读取音频失败: {error}"))?;
    if bytes.is_empty() {
        return Err("音频文件为空".to_string());
    }
    if bytes.len() > TRANSCRIBE_MAX_BYTES {
        return Err(format!(
            "音频超过上限 {} MB，无法转写",
            TRANSCRIBE_MAX_BYTES / 1024 / 1024
        ));
    }
    let api_key = resolve_api_key(args.api_key_env.as_deref().unwrap_or(""))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("audio")
        .to_string();
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str("application/octet-stream")
        .map_err(|error| format!("构造音频分片失败: {error}"))?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("response_format", "json");
    if !args.model.trim().is_empty() {
        form = form.text("model", args.model.trim().to_string());
    }
    if let Some(language) = args.language.as_deref().map(str::trim) {
        if !language.is_empty() {
            form = form.text("language", language.to_string());
        }
    }
    let client = crate::http::shared_client(60)?;
    let request = client
        .post(endpoint_url(base_url, "audio/transcriptions"))
        .multipart(form);
    let empty = HashMap::new();
    let headers = args.headers.as_ref().unwrap_or(&empty);
    let request = apply_auth(request, &api_key, headers)?;
    let response = request
        .send()
        .await
        .map_err(|error| format!("llm transcribe request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = crate::http::read_text(response, crate::http::RESPONSE_READ_TIMEOUT)
            .await
            .unwrap_or_default();
        return Err(format!(
            "llm transcribe returned {status}: {}（确认本地服务支持 /v1/audio/transcriptions）",
            truncate(&body, 200)
        ));
    }
    let body: serde_json::Value =
        crate::http::read_json(response, crate::http::RESPONSE_READ_TIMEOUT).await?;
    let text = body
        .get("text")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(TranscribeResult { text })
}
