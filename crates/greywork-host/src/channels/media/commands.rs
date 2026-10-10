//! 命令入参。

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeMediaArgs {
    pub channel: String,
    pub path: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMediaArgs {
    pub channel: String,
    pub peer_id: String,
    pub path: String,
    pub kind: Option<String>,
    pub context_token: Option<String>,
}
