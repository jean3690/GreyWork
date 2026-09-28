//! 云端 Office 命令的桌面薄包装；实现收在 `greywork_host::office`（与 headless 服务端共用）。
//!
//! 桌面与 headless 的差异只在**谁能内嵌**：桌面 CSP 写死在 `tauri.conf.json`，
//! 只有 `greywork_host::office::EMBEDDABLE_FRAME_ORIGINS` 里那几个来源能进 iframe；
//! 服务端的 CSP 是启动时按配置拼的（见 `apps/server/src/middleware.rs`）。
//! 渲染端据 `office_host_info` 的 `embeddableFrameOrigins` 决定要不要走云端。

use std::collections::HashMap;

use greywork_host::office::{HostInfo, HostInfoArgs, OfficeRecipe, PreviewOpenArgs, PreviewResult};
use tauri::State;

use crate::workspace_fs::WorkspaceFsAccess;

/// 上传工作区文件到厂商 API，取回可嵌入的文档地址（云端 Office 预览）。
#[tauri::command]
pub async fn office_preview_open(
    access: State<'_, WorkspaceFsAccess>,
    path: String,
    recipe: OfficeRecipe,
    credential_env: Option<String>,
    headers: Option<HashMap<String, String>>,
) -> Result<PreviewResult, String> {
    greywork_host::office::open_preview(
        &access,
        PreviewOpenArgs {
            path,
            recipe,
            credential_env,
            headers,
        },
    )
    .await
}

/// 宿主侧事实：桌面端可内嵌的 origin + 各凭证环境变量是否已设置（只回名字，不回值）。
///
/// 桌面壳的 CSP 写死在 `tauri.conf.json`（运行期改不了），所以这里传的就是那份静态白名单；
/// 漂移测试 `desktop_csp_frame_src_matches_embeddable_origins` 守住它与打包配置一致。
#[tauri::command]
pub fn office_host_info(env_names: Vec<String>) -> HostInfo {
    let origins: Vec<String> = greywork_host::office::EMBEDDABLE_FRAME_ORIGINS
        .iter()
        .map(|origin| origin.to_string())
        .collect();
    greywork_host::office::host_info(&origins, HostInfoArgs { env_names })
}
