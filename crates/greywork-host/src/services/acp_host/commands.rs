//! 命令入参。

use super::prompt::PromptUnit;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRespondArgs {
    pub request_id: u64,
    pub option_id: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    pub agent_cmd: String,
    pub tier: Option<String>,
    pub env: Option<std::collections::HashMap<String, String>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionArgs {
    pub handle: u64,
    pub cwd: String,
    pub mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadSessionArgs {
    pub handle: u64,
    pub cwd: String,
    pub session_id: String,
    pub mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendArgs {
    pub handle: u64,
    pub text: String,
    pub units: Option<Vec<PromptUnit>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetConfigArgs {
    pub handle: u64,
    pub config_id: String,
    pub value: serde_json::Value,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopArgs {
    pub handle: u64,
    pub turn_id: Option<u64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelSessionArgs {
    pub handle: u64,
    pub session_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPermissionTierArgs {
    pub handle: u64,
    pub tier: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectProgramsArgs {
    pub programs: Vec<String>,
}
