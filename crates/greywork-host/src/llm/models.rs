//! 模型发现：`GET /models`（设置页下拉 + 连通性自检）。

use std::collections::HashMap;

use super::dto::ListModelsArgs;
use super::transport::{apply_auth, endpoint_url, resolve_api_key, truncate};
/// 拉取 `GET /models` 的模型 id 清单。既供设置页做模型下拉，也兼作连通性自检
/// （能列出来 = Base URL 可达 + 鉴权正确）。
pub async fn llm_list_models(args: ListModelsArgs) -> Result<Vec<String>, String> {
    let base_url = args.base_url.trim();
    if base_url.is_empty() {
        return Err("base_url is required".to_string());
    }
    let api_key = resolve_api_key(args.api_key_env.as_deref().unwrap_or(""))?;
    let empty = HashMap::new();
    let headers = args.headers.as_ref().unwrap_or(&empty);
    let client = crate::http::shared_client(10)?;
    let request = client.get(endpoint_url(base_url, "models"));
    let request = apply_auth(request, &api_key, headers)?;
    let response = request
        .send()
        .await
        .map_err(|error| format!("llm models request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = crate::http::read_text(response, crate::http::RESPONSE_READ_TIMEOUT)
            .await
            .unwrap_or_default();
        return Err(format!(
            "llm endpoint returned {status}: {}（检查 Base URL 是否正确、本地服务是否在运行）",
            truncate(&body, 200)
        ));
    }
    let body: serde_json::Value =
        crate::http::read_json(response, crate::http::RESPONSE_READ_TIMEOUT).await?;
    Ok(collect_model_ids(&body))
}

/// 从 `/models` 响应里收集模型 id：兼容 OpenAI `data[].id` 与 Ollama 原生 `models[].name`。
pub(super) fn collect_model_ids(body: &serde_json::Value) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    if let Some(data) = body.get("data").and_then(|value| value.as_array()) {
        for item in data {
            if let Some(id) = item.get("id").and_then(|value| value.as_str()) {
                ids.push(id.to_string());
            }
        }
    }
    if let Some(models) = body.get("models").and_then(|value| value.as_array()) {
        for item in models {
            if let Some(name) = item.get("name").and_then(|value| value.as_str()) {
                ids.push(name.to_string());
            }
        }
    }
    ids.sort();
    ids.dedup();
    ids
}
