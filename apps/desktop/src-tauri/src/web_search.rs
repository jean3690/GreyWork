//! 网页搜索代理（宿主 reqwest）。
//!
//! 密钥由宿主从环境变量解析，渲染端不直连外网（CSP 无需放行搜索域名）。
//! 按 provider_id 分发线格式并归一化输出 `{title,url,snippet}`：
//! - `tavily`（默认兜底）：POST endpoint，Bearer 认证，body {query,max_results}
//! - `brave`：GET endpoint?q=&count=，X-Subscription-Token 认证

use std::time::Duration;

use serde::Serialize;

/// 单条归一化结果。
#[derive(Debug, Clone, Serialize)]
pub struct WebSearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// 提取非空字符串字段；空串视为缺失。
fn str_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .filter(|raw| !raw.is_empty())
        .map(str::to_string)
}

/// Tavily：body.results[]，摘要字段为 content。
pub fn normalize_tavily(body: &serde_json::Value) -> Vec<WebSearchHit> {
    body.get("results")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(WebSearchHit {
                        title: str_field(item, "title")?,
                        url: str_field(item, "url")?,
                        snippet: str_field(item, "content").unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Brave：body.web.results[]，摘要字段为 description。
pub fn normalize_brave(body: &serde_json::Value) -> Vec<WebSearchHit> {
    body.get("web")
        .and_then(|web| web.get("results"))
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(WebSearchHit {
                        title: str_field(item, "title")?,
                        url: str_field(item, "url")?,
                        snippet: str_field(item, "description").unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 发起一次网页搜索；密钥缺失 / 上游错误以 Err 文本返回。
#[tauri::command]
pub async fn web_search(
    provider_id: String,
    endpoint: String,
    api_key_env: Option<String>,
    query: String,
    max_results: Option<u32>,
) -> Result<Vec<WebSearchHit>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("query is empty".to_string());
    }
    let endpoint = endpoint.trim();
    if endpoint.is_empty() {
        return Err(format!("endpoint is empty for provider {provider_id}"));
    }
    let api_key = std::env::var(api_key_env.as_deref().unwrap_or("")).unwrap_or_default();
    if api_key.is_empty() {
        return Err(format!("missing API key env for provider {provider_id}"));
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("http client build failed: {error}"))?;

    let limit = max_results.unwrap_or(5).clamp(1, 20);
    let limit_str = limit.to_string();
    let response = match provider_id.as_str() {
        "brave" => {
            client
                .get(endpoint)
                .query(&[("q", query), ("count", limit_str.as_str())])
                .header("X-Subscription-Token", api_key)
                .send()
                .await
        }
        _ => {
            client
                .post(endpoint)
                .bearer_auth(api_key)
                .json(&serde_json::json!({ "query": query, "max_results": limit }))
                .send()
                .await
        }
    }
    .map_err(|error| format!("search request failed: {error}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("search endpoint returned {status}"));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("invalid search response: {error}"))?;

    Ok(match provider_id.as_str() {
        "brave" => normalize_brave(&body),
        _ => normalize_tavily(&body),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tavily_normalizer_maps_content_snippets() {
        let body = json!({
            "results": [
                { "title": "GreyWork", "url": "https://gw.dev", "content": "工作台" },
                { "title": "", "url": "https://x.dev", "content": "缺标题应丢弃" },
                { "title": "无URL", "content": "缺URL应丢弃" },
            ],
        });
        let hits = normalize_tavily(&body);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "GreyWork");
        assert_eq!(hits[0].snippet, "工作台");
        assert!(normalize_tavily(&json!({})).is_empty());
    }

    #[test]
    fn brave_normalizer_reads_nested_web_results() {
        let body = json!({
            "web": { "results": [
                { "title": "Brave", "url": "https://brave.com", "description": "搜索引擎" },
            ] },
        });
        let hits = normalize_brave(&body);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].snippet, "搜索引擎");
        assert!(normalize_brave(&json!({ "web": {} })).is_empty());
    }
}
