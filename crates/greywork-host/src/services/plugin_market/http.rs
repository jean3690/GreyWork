//! 限额下载（读取上限 + 超时）。

use futures_util::StreamExt;
use reqwest::Response;

use super::READ_TIMEOUT;

pub(super) async fn read_limited(response: Response, max_bytes: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|size| size > max_bytes as u64)
    {
        return Err(format!("response exceeds {max_bytes} bytes"));
    }
    let mut stream = response.bytes_stream();
    let read = async {
        let mut out = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("response read failed: {error}"))?;
            if out.len() + chunk.len() > max_bytes {
                return Err(format!("response exceeds {max_bytes} bytes"));
            }
            out.extend_from_slice(&chunk);
        }
        Ok(out)
    };
    tokio::time::timeout(READ_TIMEOUT, read)
        .await
        .map_err(|_| "response read timed out".to_string())?
}

pub(super) async fn fetch_json(url: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
    let url = super::validate::validate_github_url(url)?;
    let response = crate::http::shared_client(10)?
        .get(url)
        .header(reqwest::header::USER_AGENT, "GreyWork-Plugin-Market/1")
        .send()
        .await
        .map_err(|error| format!("plugin market request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "plugin market request returned {}",
            response.status()
        ));
    }
    read_limited(response, max_bytes).await
}
