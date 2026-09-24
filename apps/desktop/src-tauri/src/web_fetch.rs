//! 网页抓取的桌面命令入口；实现收在 `greywork_host::web_fetch`。

use greywork_host::web_fetch::{WebFetchRequest, WebFetchResponse};

/// 取回一个 http(s) 页面的 HTML 原文（正文提取在渲染端做）。
#[tauri::command]
pub async fn web_fetch(request: WebFetchRequest) -> Result<WebFetchResponse, String> {
    greywork_host::web_fetch::web_fetch(request).await
}
