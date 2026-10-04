//! 向量：`POST /embeddings` 与 [`crate::core::ports::Embedder`] 端口实现。

use std::collections::HashMap;

use super::dto::{EmbedArgs, EmbedResult};
use super::transport::{apply_auth, endpoint_url, resolve_api_key, truncate};
/// [`crate::core::ports::Embedder`] 的默认实现：把请求转给 [`llm_embed`]（宿主 HTTP）。
///
/// 无状态零尺寸 —— RAG 侧只需借一个实例即可调用，无需装配。
#[derive(Debug, Default, Clone, Copy)]
pub struct LlmEmbedder;

impl crate::core::ports::Embedder for LlmEmbedder {
    fn embed<'a>(
        &'a self,
        args: EmbedArgs,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<EmbedResult, String>> + Send + 'a>>
    {
        Box::pin(llm_embed(args))
    }
}

/// 批量取文本向量（`POST /embeddings`）。RAG 索引与查询共用。
pub async fn llm_embed(args: EmbedArgs) -> Result<EmbedResult, String> {
    let base_url = args.base_url.trim();
    let model = args.model.trim();
    if base_url.is_empty() || model.is_empty() {
        return Err("base_url and model are required".to_string());
    }
    if args.input.is_empty() {
        return Ok(EmbedResult {
            embeddings: Vec::new(),
            dim: 0,
            model: model.to_string(),
        });
    }
    let api_key = resolve_api_key(args.api_key_env.as_deref().unwrap_or(""))?;
    let empty = HashMap::new();
    let headers = args.headers.as_ref().unwrap_or(&empty);
    let client = crate::http::shared_client(30)?;
    let request = client
        .post(endpoint_url(base_url, "embeddings"))
        .json(&serde_json::json!({ "model": model, "input": args.input }));
    let request = apply_auth(request, &api_key, headers)?;
    let response = request
        .send()
        .await
        .map_err(|error| format!("llm embeddings request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = crate::http::read_text(response, crate::http::RESPONSE_READ_TIMEOUT)
            .await
            .unwrap_or_default();
        return Err(format!(
            "llm embeddings returned {status}: {}（确认该模型是 embedding 模型、且服务支持 /v1/embeddings）",
            truncate(&body, 200)
        ));
    }
    let body: serde_json::Value =
        crate::http::read_json(response, crate::http::RESPONSE_READ_TIMEOUT).await?;
    let embeddings = parse_embeddings(&body)?;
    let dim = embeddings.first().map_or(0, Vec::len);
    Ok(EmbedResult {
        embeddings,
        dim,
        model: model.to_string(),
    })
}

/// 解析向量响应：OpenAI `data[].embedding`、批式 `embeddings[][]`、单条 `embedding[]` 三种形状。
pub(super) fn parse_embeddings(body: &serde_json::Value) -> Result<Vec<Vec<f32>>, String> {
    let to_vec = |value: &serde_json::Value| -> Option<Vec<f32>> {
        value.as_array().map(|arr| {
            arr.iter()
                .map(|n| n.as_f64().unwrap_or(0.0) as f32)
                .collect()
        })
    };
    if let Some(data) = body.get("data").and_then(|value| value.as_array()) {
        let out: Vec<Vec<f32>> = data
            .iter()
            .filter_map(|item| item.get("embedding").and_then(&to_vec))
            .collect();
        if !out.is_empty() {
            return Ok(out);
        }
    }
    if let Some(embeddings) = body.get("embeddings").and_then(|value| value.as_array()) {
        let out: Vec<Vec<f32>> = embeddings.iter().filter_map(&to_vec).collect();
        if !out.is_empty() {
            return Ok(out);
        }
    }
    if let Some(single) = body.get("embedding").and_then(&to_vec) {
        return Ok(vec![single]);
    }
    Err("embedding 响应里没有向量（确认模型是 embedding 模型）".to_string())
}
