//! 插件市场宿主。
//!
//! 注册表与插件包来自 GitHub HTTPS。声明式包只包含受限 JSON；代码包额外下载一个
//! SHA-256 固定的 ES module，并仅在 Web Worker 中执行。安装前校验来源、体积、身份、
//! schema 与持久化键；落盘到 `<app_data>/plugins/<plugin-id>/`。

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::http::shared_client;

const MAX_REGISTRY_BYTES: usize = 512 * 1024;
const MAX_PACKAGE_BYTES: usize = 512 * 1024;
const MAX_CODE_BYTES: usize = 1024 * 1024;
const MAX_PLUGIN_FETCH_BYTES: usize = 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(20);
const PLUGIN_FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const ALLOWED_GITHUB_HOSTS: [&str; 4] = [
    "github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "githubusercontent.com",
];
/// 官方市场信任根：ed25519 公钥（hex）。私钥离线保存（plugin-market/.signing-key.pem，
/// gitignored），仅签名脚本使用。
/// registry 携带合法签名 = GitHub 账号失陷后攻击者仍无法投毒插件目录；
/// 未签名的自建源走「用户自担」路径，但伪造签名（有 signature 验不过）一律拒绝。
const OFFICIAL_REGISTRY_PUBLIC_KEY: &str =
    "983774e8797787351696d612266aa8661d1cfcb93a2def570e090479da328ea3";
/// 官方市场 registry.json 地址（前端默认值须与此一致）。
const OFFICIAL_REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/jean3690/greywork-plugin-market/main/registry.json";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRegistry {
    pub schema_version: u32,
    pub plugins: Vec<PluginRegistryEntry>,
    /// registry 规范化内容（去掉本字段）的 ed25519 签名，base64。
    /// 默认市场必须存在且验签通过；自建源可缺省。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRegistryEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub author: Option<String>,
    pub download_url: String,
    pub sha256: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackage {
    pub schema_version: u32,
    pub manifest: MarketPluginManifest,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    #[serde(default)]
    pub kind: PluginKind,
    pub runtime: Option<CodePluginRuntime>,
    #[serde(default)]
    pub requires: Vec<CapabilityRequirement>,
    /// 可选脱窗声明：worker+render 包可申请宿主悬浮窗（透明置顶），尺寸有界。
    pub window: Option<PluginWindowDecl>,
    pub contributes: DeclarativeContributions,
}

/// 悬浮窗声明：宿主按此建透明置顶小窗；内容 = 该包的 render 指令流。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginWindowDecl {
    pub width: u32,
    pub height: u32,
}

/// manifest `requires` 项：字符串 = 无参数；对象 = 带资源参数
/// （目前仅 net.fetch 的 hosts 域名白名单）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum CapabilityRequirement {
    Plain(String),
    Parameterized {
        capability: String,
        #[serde(default)]
        hosts: Vec<String>,
    },
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PluginKind {
    #[default]
    Declarative,
    Worker,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodePluginRuntime {
    #[serde(rename = "type")]
    pub runtime_type: String,
    pub entry: String,
    pub sha256: String,
    /// 可选渲染循环：worker 暴露该 handler，宿主按 fps 轮询拉取绘图指令集。
    /// 指令白名单在宿主前端校验（canvas 尺寸有限，数值有界）。
    pub render: Option<RenderLoop>,
}

/// 渲染循环声明：fps 有界（1-60），画布尺寸有界（≤512）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderLoop {
    pub handler: String,
    pub fps: Option<u32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclarativeContributions {
    #[serde(default)]
    pub modes: Vec<DeclarativeMode>,
    /// 区域贡献（v2）：worker 包把渲染循环挂到宿主区域（shellSidebar/activityPanel）。
    #[serde(default)]
    pub ui_regions: Vec<MarketUiRegionContribution>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketUiRegionContribution {
    pub region: String,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub order: Option<i32>,
    #[serde(default)]
    pub overflow: Option<bool>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub actions: Vec<MarketRegionAction>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRegionAction {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclarativeMode {
    pub id: String,
    pub title: String,
    pub icon: Option<String>,
    pub page: DeclarativePage,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclarativePage {
    pub eyebrow: Option<String>,
    pub heading: String,
    pub body: String,
    pub counter_label: Option<String>,
    #[serde(default)]
    pub fields: Vec<DeclarativeField>,
    #[serde(default)]
    pub outputs: Vec<DeclarativeOutput>,
    #[serde(default)]
    pub actions: Vec<DeclarativeAction>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclarativeField {
    pub key: String,
    pub label: String,
    pub description: Option<String>,
    pub kind: String,
    pub default: serde_json::Value,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    pub max_length: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclarativeOutput {
    pub label: String,
    pub value_key: String,
    pub suffix: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclarativeAction {
    pub id: String,
    pub label: String,
    pub style: Option<String>,
    pub operation: DeclarativeOperation,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DeclarativeOperation {
    Increment {
        key: String,
        amount: Option<f64>,
    },
    Set {
        key: String,
        value: serde_json::Value,
    },
    Reset,
    Invoke {
        handler: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallReport {
    pub id: String,
    pub version: String,
    pub path: String,
}

pub fn validate_key(raw: &str, label: &str) -> Result<(), String> {
    let valid = !raw.is_empty()
        && raw.len() <= 96
        && raw
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        && raw.chars().all(|ch| {
            ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '-' | '_' | ':')
        });
    if valid {
        Ok(())
    } else {
        Err(format!("invalid {label}: {raw:?}"))
    }
}

/// 会被当作**目录名**使用的 key（插件 id）。
///
/// `validate_key` 放行冒号（能力名形如 `demo:run`，见随包 registry），但插件 id 会经
/// `root.join(id)` 落到文件系统上，必须再按路径段规则挡一层：盘符相对路径 `c:evil`
/// 会让 `join` 整段替换基准目录，另外还有 Win32 保留设备名与结尾点/空格。
pub fn validate_dir_key(raw: &str, label: &str) -> Result<(), String> {
    validate_key(raw, label)?;
    if crate::path_safety::is_safe_path_segment(raw) {
        Ok(())
    } else {
        Err(format!("invalid {label}: {raw:?}"))
    }
}

fn validate_version(raw: &str) -> Result<(), String> {
    let parts: Vec<&str> = raw.split('.').collect();
    if parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
    {
        Ok(())
    } else {
        Err(format!("invalid version (expected x.y.z): {raw:?}"))
    }
}

fn validate_github_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|error| format!("invalid GitHub URL: {error}"))?;
    let host = url.host_str().unwrap_or_default();
    if url.scheme() != "https" || !ALLOWED_GITHUB_HOSTS.contains(&host) {
        return Err(format!(
            "plugin market URL must use HTTPS on an allowed GitHub host: {raw}"
        ));
    }
    Ok(url)
}

fn validate_sha256(raw: &str) -> Result<(), String> {
    if raw.len() == 64
        && raw
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err("sha256 must be 64 lowercase hexadecimal characters".to_string())
    }
}
fn validate_value_kind(value: &serde_json::Value, kind: &str) -> bool {
    match kind {
        "text" => value.is_string(),
        "number" => value.is_number(),
        "toggle" => value.is_boolean(),
        _ => false,
    }
}

fn validate_page(mode_id: &str, page: &DeclarativePage) -> Result<(), String> {
    if page.fields.len() > 32 || page.outputs.len() > 32 || page.actions.len() > 32 {
        return Err(format!(
            "mode {mode_id} exceeds 32 fields, outputs, or actions"
        ));
    }
    let mut field_kinds = std::collections::HashMap::new();
    for field in &page.fields {
        validate_key(&field.key, "field key")?;
        if field.label.trim().is_empty() || field.label.len() > 120 {
            return Err(format!(
                "field {} requires a label of at most 120 characters",
                field.key
            ));
        }
        if !validate_value_kind(&field.default, &field.kind) {
            return Err(format!(
                "field {} default does not match kind {}",
                field.key, field.kind
            ));
        }
        if field.kind != "number"
            && (field.min.is_some() || field.max.is_some() || field.step.is_some())
        {
            return Err(format!(
                "field {} numeric bounds require kind number",
                field.key
            ));
        }
        if field.kind != "text" && field.max_length.is_some() {
            return Err(format!("field {} maxLength requires kind text", field.key));
        }
        if field.min.zip(field.max).is_some_and(|(min, max)| min > max) {
            return Err(format!("field {} min must not exceed max", field.key));
        }
        if field.step.is_some_and(|step| step <= 0.0)
            || field.max_length.is_some_and(|length| length > 4096)
        {
            return Err(format!("field {} has invalid step or maxLength", field.key));
        }
        if field_kinds
            .insert(field.key.as_str(), field.kind.as_str())
            .is_some()
        {
            return Err(format!(
                "duplicate field key in mode {mode_id}: {}",
                field.key
            ));
        }
    }
    for output in &page.outputs {
        if output.label.trim().is_empty() || !field_kinds.contains_key(output.value_key.as_str()) {
            return Err(format!(
                "mode {mode_id} output references unknown field: {}",
                output.value_key
            ));
        }
    }
    let mut action_ids = std::collections::HashSet::new();
    for action in &page.actions {
        validate_key(&action.id, "action id")?;
        if action.label.trim().is_empty() || !action_ids.insert(action.id.as_str()) {
            return Err(format!(
                "mode {mode_id} has an invalid or duplicate action: {}",
                action.id
            ));
        }
        if action
            .style
            .as_deref()
            .is_some_and(|style| !matches!(style, "primary" | "secondary" | "danger"))
        {
            return Err(format!("action {} has invalid style", action.id));
        }
        match &action.operation {
            DeclarativeOperation::Reset => {}
            DeclarativeOperation::Invoke { handler } => {
                validate_key(handler, "worker handler")?;
            }
            DeclarativeOperation::Set { key, value } => {
                let kind = field_kinds.get(key.as_str()).ok_or_else(|| {
                    format!("action {} references unknown field: {key}", action.id)
                })?;
                if !validate_value_kind(value, kind) {
                    return Err(format!(
                        "action {} value does not match field {key}",
                        action.id
                    ));
                }
            }
            DeclarativeOperation::Increment { key, amount } => {
                if field_kinds.get(key.as_str()) != Some(&"number")
                    || amount.is_some_and(|value| !value.is_finite())
                {
                    return Err(format!(
                        "action {} increment requires a numeric field and finite amount",
                        action.id
                    ));
                }
            }
        }
    }
    Ok(())
}

fn validate_registry(registry: &PluginRegistry, registry_url: &str) -> Result<(), String> {
    if registry.schema_version != 1 {
        return Err(format!(
            "unsupported registry schema version: {}",
            registry.schema_version
        ));
    }
    if registry.plugins.len() > 256 {
        return Err("registry has too many plugins (max 256)".to_string());
    }
    let mut ids = std::collections::HashSet::new();
    for entry in &registry.plugins {
        validate_key(&entry.id, "plugin id")?;
        validate_version(&entry.version)?;
        validate_github_url(&entry.download_url)?;
        validate_sha256(&entry.sha256)?;
        if !ids.insert(&entry.id) {
            return Err(format!("duplicate registry plugin id: {}", entry.id));
        }
    }
    verify_registry_signature(registry, registry_url)
}
fn verify_registry_signature(registry: &PluginRegistry, registry_url: &str) -> Result<(), String> {
    let is_official = registry_url == OFFICIAL_REGISTRY_URL;
    let Some(_signature) = &registry.signature else {
        if is_official {
            return Err("official plugin registry is missing its signature".to_string());
        }
        return Ok(());
    };
    let Ok(public_key_bytes) = hex_decode_32(OFFICIAL_REGISTRY_PUBLIC_KEY) else {
        return Err("official registry public key is misconfigured".to_string());
    };
    verify_registry_signature_with(registry, &public_key_bytes)
}

fn verify_registry_signature_with(
    registry: &PluginRegistry,
    public_key_bytes: &[u8; 32],
) -> Result<(), String> {
    let Ok(public_key) = ed25519_dalek::VerifyingKey::from_bytes(public_key_bytes) else {
        return Err("official registry public key is invalid".to_string());
    };
    use ed25519_dalek::Verifier;
    let unsigned = PluginRegistry {
        schema_version: registry.schema_version,
        plugins: registry.plugins.clone(),
        signature: None,
    };
    let message = serde_json::to_vec(&unsigned)
        .map_err(|error| format!("canonicalize registry failed: {error}"))?;
    use base64::Engine;
    let Ok(signature_bytes) = base64::engine::general_purpose::STANDARD
        .decode(registry.signature.as_deref().unwrap_or_default())
    else {
        return Err("registry signature is not valid base64".to_string());
    };
    let Ok(signature) = ed25519_dalek::Signature::from_slice(&signature_bytes) else {
        return Err("registry signature has wrong length".to_string());
    };
    public_key
        .verify(&message, &signature)
        .map_err(|_| "registry signature verification failed".to_string())
}

fn hex_decode_32(input: &str) -> Result<[u8; 32], ()> {
    let mut out = [0u8; 32];
    if input.len() != 64 {
        return Err(());
    }
    for (index, chunk) in input.as_bytes().chunks(2).enumerate() {
        let high = (chunk[0] as char).to_digit(16).ok_or(())? as u8;
        let low = (chunk[1] as char).to_digit(16).ok_or(())? as u8;
        out[index] = (high << 4) | low;
    }
    Ok(out)
}

fn validate_requirement(requirement: &CapabilityRequirement) -> Result<(), String> {
    match requirement {
        CapabilityRequirement::Plain(capability) => {
            validate_key(capability, "required capability")?;
            if capability == "net.fetch" {
                return Err("net.fetch requires a host allowlist: use { \"capability\": \"net.fetch\", \"hosts\": [...] }".to_string());
            }
            Ok(())
        }
        CapabilityRequirement::Parameterized { capability, hosts } => {
            validate_key(capability, "required capability")?;
            if capability != "net.fetch" {
                return Err(format!(
                    "capability {capability} does not accept parameters; use the plain string form"
                ));
            }
            if hosts.is_empty() || hosts.len() > 16 {
                return Err("net.fetch hosts allowlist must contain 1-16 entries".to_string());
            }
            for host in hosts {
                validate_host(host)?;
            }
            Ok(())
        }
    }
}

fn validate_host(host: &str) -> Result<(), String> {
    let labels: Vec<&str> = host.split('.').collect();
    if host.len() > 253 || labels.len() < 2 {
        return Err(format!("invalid host in allowlist: {host}"));
    }
    for label in labels {
        if label.is_empty()
            || label.len() > 63
            || !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            || label.starts_with('-')
            || label.ends_with('-')
        {
            return Err(format!("invalid host in allowlist: {host}"));
        }
    }
    Ok(())
}

fn validate_package(package: &PluginPackage) -> Result<(), String> {
    if package.schema_version != 1 {
        return Err(format!(
            "unsupported package schema version: {}",
            package.schema_version
        ));
    }
    let manifest = &package.manifest;
    validate_dir_key(&manifest.id, "plugin id")?;
    if manifest.id.starts_with("core.") {
        return Err("plugin id prefix core. is reserved for built-in plugins".to_string());
    }
    validate_version(&manifest.version)?;
    if manifest.name.trim().is_empty() || manifest.name.len() > 120 {
        return Err("plugin name must contain 1-120 characters".to_string());
    }
    match (&manifest.kind, &manifest.runtime) {
        (PluginKind::Declarative, None) => {}
        (PluginKind::Worker, Some(runtime)) => {
            if runtime.runtime_type != "worker" {
                return Err("code plugin runtime type must be worker".to_string());
            }
            validate_github_url(&runtime.entry)?;
            validate_sha256(&runtime.sha256)?;
            if let Some(render) = &runtime.render {
                validate_key(&render.handler, "render handler")?;
                if let Some(fps) = render.fps {
                    if !(1..=60).contains(&fps) {
                        return Err(format!("render fps must be 1-60, got {fps}"));
                    }
                }
                for size in [render.width, render.height] {
                    if size.is_some_and(|value| value == 0 || value > 512) {
                        return Err("render canvas size must be 1-512 pixels".to_string());
                    }
                }
            }
        }
        (PluginKind::Declarative, Some(_)) => {
            return Err("declarative plugin must not define a runtime".to_string());
        }
        (PluginKind::Worker, None) => return Err("worker plugin requires a runtime".to_string()),
    }
    if manifest.contributes.modes.is_empty() || manifest.contributes.modes.len() > 8 {
        return Err("plugin must contribute 1-8 modes".to_string());
    }
    for required in &manifest.requires {
        validate_requirement(required)?;
    }
    let mut mode_ids = std::collections::HashSet::new();

    for mode in &manifest.contributes.modes {
        validate_key(&mode.id, "mode id")?;
        if mode.id == "plugins" {
            return Err("mode id plugins is reserved for the built-in plugin center".to_string());
        }
        if !mode_ids.insert(&mode.id) {
            return Err(format!("duplicate mode id in package: {}", mode.id));
        }
        if mode.title.trim().is_empty() || mode.page.heading.trim().is_empty() {
            return Err(format!("mode {} requires title and page heading", mode.id));
        }
        if mode.page.body.len() > 16 * 1024 {
            return Err(format!("mode {} body is too large", mode.id));
        }
        validate_page(&mode.id, &mode.page)?;
        let has_invoke = mode
            .page
            .actions
            .iter()
            .any(|action| matches!(action.operation, DeclarativeOperation::Invoke { .. }));
        if has_invoke != (manifest.kind == PluginKind::Worker) && has_invoke {
            return Err("invoke actions require a worker plugin".to_string());
        }
    }
    if let Some(window) = &manifest.window {
        if manifest.kind != PluginKind::Worker
            || manifest
                .runtime
                .as_ref()
                .and_then(|runtime| runtime.render.as_ref())
                .is_none()
        {
            return Err(
                "window declaration requires a worker plugin with a render loop".to_string(),
            );
        }
        for size in [window.width, window.height] {
            if size == 0 || size > 512 {
                return Err("plugin window size must be 1-512 pixels".to_string());
            }
        }
    }
    validate_ui_regions(manifest)?;
    Ok(())
}

/// 区域贡献校验：仅 worker 包（需渲染循环驱动）、区域白名单、尺寸/标题/动作有界。
fn validate_ui_regions(manifest: &MarketPluginManifest) -> Result<(), String> {
    if manifest.contributes.ui_regions.is_empty() {
        return Ok(());
    }
    if manifest.kind != PluginKind::Worker {
        return Err("uiRegions contributions require a worker plugin".to_string());
    }
    if manifest
        .runtime
        .as_ref()
        .and_then(|runtime| runtime.render.as_ref())
        .is_none()
    {
        return Err("uiRegions contributions require a render loop (runtime.render)".to_string());
    }
    let mut region_ids = std::collections::HashSet::new();
    for region in &manifest.contributes.ui_regions {
        if !matches!(
            region.region.as_str(),
            "shellSidebar" | "activityPanel" | "workspaceOverlay"
        ) {
            return Err(format!(
                "uiRegion has unsupported host region: {}",
                region.region
            ));
        }
        validate_key(&region.id, "uiRegion id")?;
        if !region_ids.insert(&region.id) {
            return Err(format!("duplicate uiRegion id in package: {}", region.id));
        }
        if region.title.trim().is_empty() || region.title.len() > 80 {
            return Err(format!(
                "uiRegion {} requires a 1-80 character title",
                region.id
            ));
        }
        for size in [region.width, region.height] {
            if size.is_some_and(|value| value == 0 || value > 512) {
                return Err(format!(
                    "uiRegion {} canvas size must be 1-512 pixels",
                    region.id
                ));
            }
        }
        if region.actions.len() > 4 {
            return Err(format!("uiRegion {} exceeds 4 action buttons", region.id));
        }
        let mut action_ids = std::collections::HashSet::new();
        for action in &region.actions {
            validate_key(&action.id, "region action id")?;
            if action.label.trim().is_empty()
                || action.label.len() > 20
                || !action_ids.insert(&action.id)
            {
                return Err(format!(
                    "uiRegion {} has an invalid or duplicate action",
                    region.id
                ));
            }
        }
    }
    Ok(())
}

async fn read_limited(response: reqwest::Response, max_bytes: usize) -> Result<Vec<u8>, String> {
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

async fn fetch_json(url: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
    let url = validate_github_url(url)?;
    let response = shared_client(10)?
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

fn plugins_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("plugins"))
        .map_err(|error| format!("resolve app data directory failed: {error}"))
}

fn install_package_at(root: &Path, package: &PluginPackage) -> Result<PathBuf, String> {
    validate_package(package)?;
    let target = root.join(&package.manifest.id);
    std::fs::create_dir_all(&target)
        .map_err(|error| format!("create plugin directory failed: {error}"))?;
    let final_path = target.join("plugin.json");
    let temp_path = target.join("plugin.json.tmp");
    let bytes = serde_json::to_vec_pretty(package)
        .map_err(|error| format!("serialize plugin failed: {error}"))?;
    std::fs::write(&temp_path, bytes).map_err(|error| format!("write plugin failed: {error}"))?;
    // 直接 rename 覆盖：Windows 上 `std::fs::rename` 走 MoveFileEx(REPLACE_EXISTING)，
    // 本来就能替换；先 remove_file 只是多一个会失败的步骤。
    std::fs::rename(&temp_path, &final_path)
        .map_err(|error| format!("commit plugin failed: {error}"))?;
    Ok(final_path)
}

#[tauri::command]
pub async fn plugin_market_catalog(registry_url: String) -> Result<PluginRegistry, String> {
    let bytes = fetch_json(&registry_url, MAX_REGISTRY_BYTES).await?;
    let registry: PluginRegistry = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid plugin registry JSON: {error}"))?;
    validate_registry(&registry, &registry_url)?;
    Ok(registry)
}

fn list_installed_at(root: &Path) -> Result<Vec<PluginPackage>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut packages = Vec::new();
    let entries = std::fs::read_dir(root)
        .map_err(|error| format!("read plugin directory failed: {error}"))?;
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let path = entry.path().join("plugin.json");
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if bytes.len() > MAX_PACKAGE_BYTES + MAX_CODE_BYTES {
            continue;
        }
        let Ok(package) = serde_json::from_slice::<PluginPackage>(&bytes) else {
            continue;
        };
        if validate_package(&package).is_ok()
            && entry.file_name().to_string_lossy() == package.manifest.id
        {
            packages.push(package);
        }
    }
    packages.sort_by(|left, right| left.manifest.id.cmp(&right.manifest.id));
    Ok(packages)
}

/// 校验后的安装候选：manifest + 可选 worker 代码（已过 SHA-256 与 UTF-8 校验）。
async fn fetch_and_validate_package(
    registry_url: &str,
    plugin_id: &str,
) -> Result<PluginPackage, String> {
    validate_key(plugin_id, "plugin id")?;
    let registry = plugin_market_catalog(registry_url.to_string()).await?;
    let entry = registry
        .plugins
        .iter()
        .find(|candidate| candidate.id == plugin_id)
        .ok_or_else(|| format!("plugin not found in registry: {plugin_id}"))?;
    let bytes = fetch_json(&entry.download_url, MAX_PACKAGE_BYTES).await?;
    let actual_hash = format!("{:x}", Sha256::digest(&bytes));
    if actual_hash != entry.sha256 {
        return Err(format!(
            "plugin checksum mismatch: expected {}, got {actual_hash}",
            entry.sha256
        ));
    }
    let mut package: PluginPackage = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid plugin package JSON: {error}"))?;
    validate_package(&package)?;
    if package.manifest.id != entry.id || package.manifest.version != entry.version {
        return Err("plugin package identity does not match registry entry".to_string());
    }
    if let Some(runtime) = &package.manifest.runtime {
        let code_bytes = fetch_json(&runtime.entry, MAX_CODE_BYTES).await?;
        let actual_hash = format!("{:x}", Sha256::digest(&code_bytes));
        if actual_hash != runtime.sha256 {
            return Err(format!(
                "plugin code checksum mismatch: expected {}, got {actual_hash}",
                runtime.sha256
            ));
        }
        package.code = Some(
            String::from_utf8(code_bytes)
                .map_err(|_| "plugin code must be valid UTF-8 JavaScript".to_string())?,
        );
    }
    Ok(package)
}

#[tauri::command]
pub async fn plugin_market_preview(
    registry_url: String,
    plugin_id: String,
) -> Result<MarketPluginManifest, String> {
    // 安装前预览：下载 + 全量校验（SHA-256 / schema / hosts 白名单）但不落盘。
    // 返回 manifest 让用户在授权时刻看到精确的能力语义。
    let package = fetch_and_validate_package(&registry_url, &plugin_id).await?;
    Ok(package.manifest)
}

#[tauri::command]
pub async fn plugin_market_install(
    app: tauri::AppHandle,
    registry_url: String,
    plugin_id: String,
) -> Result<PluginInstallReport, String> {
    let package = fetch_and_validate_package(&registry_url, &plugin_id).await?;
    let path = install_package_at(&plugins_root(&app)?, &package)?;
    Ok(PluginInstallReport {
        id: package.manifest.id,
        version: package.manifest.version,
        path: path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn plugin_market_list_installed(app: tauri::AppHandle) -> Result<Vec<PluginPackage>, String> {
    list_installed_at(&plugins_root(&app)?)
}

#[tauri::command]
pub fn plugin_market_uninstall(app: tauri::AppHandle, plugin_id: String) -> Result<(), String> {
    validate_dir_key(&plugin_id, "plugin id")?;
    let target = plugins_root(&app)?.join(&plugin_id);
    if !target.exists() {
        return Err(format!("plugin not installed: {plugin_id}"));
    }
    std::fs::remove_dir_all(&target).map_err(|error| format!("remove plugin failed: {error}"))
}

/// 前端 net.fetch 能力 broker 的宿主侧代理。
///
/// 为什么不经 webview fetch：CSP `connect-src` 是文档级静态策略，无法按插件
/// hosts 白名单动态放宽；且防线放在 Rust 命令里，安装包 JS 无法绕过校验。
/// 白名单由前端 broker 传入，此处二次校验 —— 纵深防御，两边独立实现。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFetchRequest {
    pub url: String,
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// 插件 manifest 声明并经用户授权的域名白名单（来自前端 broker）。
    pub allowed_hosts: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFetchResponse {
    pub status: u16,
    pub ok: bool,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

fn plugin_fetch_host_matches(host: &str, allowed: &str) -> bool {
    host == allowed || (host.ends_with(&format!(".{allowed}")) && !allowed.contains('/'))
}

fn validate_plugin_fetch_url(url: &str, allowed_hosts: &[String]) -> Result<reqwest::Url, String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|_| format!("net.fetch url is not absolute: {url}"))?;
    if parsed.scheme() != "https" {
        return Err("net.fetch only allows https: urls".to_string());
    }
    if !parsed.username().is_empty() || !parsed.password().is_none() {
        return Err("net.fetch does not allow embedded credentials".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "net.fetch url has no host".to_string())?;
    if allowed_hosts.is_empty() {
        return Err("net.fetch requires a non-empty host allowlist".to_string());
    }
    if !allowed_hosts
        .iter()
        .any(|allowed| plugin_fetch_host_matches(host, allowed))
    {
        return Err(format!(
            "net.fetch host is not in the plugin allowlist: {host}"
        ));
    }
    Ok(parsed)
}

#[tauri::command]
pub async fn plugin_net_fetch(request: PluginFetchRequest) -> Result<PluginFetchResponse, String> {
    let url = validate_plugin_fetch_url(&request.url, &request.allowed_hosts)?;
    let method = match request.method.as_deref() {
        None | Some("GET") => reqwest::Method::GET,
        Some("HEAD") => reqwest::Method::HEAD,
        Some(other) => return Err(format!("net.fetch method must be GET or HEAD, got {other}")),
    };
    for (name, value) in &request.headers {
        if name.trim().is_empty() || value.contains(['\r', '\n']) {
            return Err(format!("net.fetch invalid header: {name}"));
        }
        // 与前端 broker 同款禁改安全敏感头（纵深防御）。
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "authorization"
                | "cookie"
                | "host"
                | "origin"
                | "referer"
                | "connection"
                | "transfer-encoding"
        ) || lower.starts_with("sec-")
        {
            return Err(format!("net.fetch forbids the header: {name}"));
        }
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        // 重定向可能跳出 hosts 白名单（如 30x 到 CDN），直接拒绝。
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("net.fetch client build failed: {error}"))?;
    let mut builder = client
        .request(method.clone(), url)
        .header(reqwest::header::USER_AGENT, "GreyWork-Plugin/1")
        .timeout(PLUGIN_FETCH_TIMEOUT);
    for (name, value) in &request.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    let response = builder
        .send()
        .await
        .map_err(|error| format!("net.fetch request failed: {error}"))?;
    let status = response.status().as_u16();
    let ok = response.status().is_success();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                value.to_str().unwrap_or("").to_string(),
            )
        })
        .collect();
    if method == reqwest::Method::HEAD {
        return Ok(PluginFetchResponse {
            status,
            ok,
            headers,
            body: None,
        });
    }
    let bytes = read_limited(response, MAX_PLUGIN_FETCH_BYTES).await?;
    let body = String::from_utf8(bytes)
        .map_err(|_| "net.fetch response is not valid UTF-8".to_string())?;
    Ok(PluginFetchResponse {
        status,
        ok,
        headers,
        body: Some(body),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo_package() -> PluginPackage {
        PluginPackage {
            schema_version: 1,
            manifest: MarketPluginManifest {
                id: "demo.counter".into(),
                name: "Demo Counter".into(),
                version: "1.0.0".into(),
                description: None,
                kind: PluginKind::Declarative,
                runtime: None,
                requires: vec![CapabilityRequirement::Plain("demo:run".into())],
                window: None,
                contributes: DeclarativeContributions {
                    modes: vec![DeclarativeMode {
                        id: "demo-counter".into(),
                        title: "Demo".into(),
                        icon: Some("lightning".into()),
                        page: DeclarativePage {
                            eyebrow: Some("Marketplace plugin".into()),
                            heading: "Demo plugin is running".into(),
                            body: "Loaded from a declarative package.".into(),
                            counter_label: None,
                            fields: vec![DeclarativeField {
                                key: "count".into(),
                                label: "Count".into(),
                                description: None,
                                kind: "number".into(),
                                default: serde_json::json!(0),
                                min: Some(0.0),
                                max: Some(100.0),
                                step: Some(1.0),
                                max_length: None,
                            }],
                            outputs: vec![DeclarativeOutput {
                                label: "Current count".into(),
                                value_key: "count".into(),
                                suffix: None,
                            }],
                            actions: vec![DeclarativeAction {
                                id: "increment".into(),
                                label: "Add one".into(),
                                style: Some("primary".into()),
                                operation: DeclarativeOperation::Increment {
                                    key: "count".into(),
                                    amount: Some(1.0),
                                },
                            }],
                        },
                    }],
                    ui_regions: Vec::new(),
                },
            },
            code: None,
        }
    }

    #[test]
    fn validates_github_only_registry_urls() {
        assert!(validate_github_url(
            "https://raw.githubusercontent.com/acme/plugins/main/registry.json"
        )
        .is_ok());
        assert!(validate_github_url(
            "http://raw.githubusercontent.com/acme/plugins/main/registry.json"
        )
        .is_err());
        assert!(validate_github_url("https://example.com/registry.json").is_err());
    }

    #[test]
    fn rejects_invalid_or_executable_shapes() {
        let mut package = demo_package();
        package.manifest.id = "../escape".into();
        assert!(validate_package(&package).is_err());

        let mut package = demo_package();
        package.manifest.contributes.modes[0].id = "UPPER".into();
        assert!(validate_package(&package).is_err());
    }

    #[test]
    fn validate_dir_key_rejects_windows_path_escapes() {
        assert!(validate_dir_key("demo.counter", "plugin id").is_ok());
        assert!(validate_dir_key("advance", "action id").is_ok());

        // 盘符相对路径：`install_package_at` 会 `root.join(id)`，冒号必须拒
        assert!(validate_dir_key("c:evil", "plugin id").is_err());
        assert!(validate_dir_key("c:", "plugin id").is_err());
        assert!(validate_dir_key("a:b", "plugin id").is_err());
        // Win32 保留设备名与结尾点
        assert!(validate_dir_key("con", "plugin id").is_err());
        assert!(validate_dir_key("nul.txt", "plugin id").is_err());
        assert!(validate_dir_key("foo.", "plugin id").is_err());

        // 但能力名允许冒号（随包 registry 里的 `demo:run`），不能被误伤
        assert!(validate_key("demo:run", "required capability").is_ok());
    }

    #[test]
    fn worker_packages_require_a_pinned_github_entry_and_allow_invoke_actions() {
        let mut package = demo_package();
        package.manifest.kind = PluginKind::Worker;
        package.manifest.runtime = Some(CodePluginRuntime {
            runtime_type: "worker".into(),
            entry: "https://raw.githubusercontent.com/acme/plugins/main/demo.js".into(),
            sha256: "a".repeat(64),
            render: None,
        });
        package.manifest.contributes.modes[0].page.actions[0].operation =
            DeclarativeOperation::Invoke {
                handler: "increment".into(),
            };
        assert!(validate_package(&package).is_ok());

        package.manifest.runtime.as_mut().unwrap().entry = "https://example.com/demo.js".into();
        assert!(validate_package(&package).is_err());
    }

    #[test]
    fn ui_region_contributions_require_worker_render_and_bounded_shape() {
        // 基础 worker + render 包。
        let worker_with_region = |regions: Vec<MarketUiRegionContribution>| {
            let mut package = demo_package();
            package.manifest.kind = PluginKind::Worker;
            package.manifest.runtime = Some(CodePluginRuntime {
                runtime_type: "worker".into(),
                entry: "https://raw.githubusercontent.com/acme/plugins/main/demo.js".into(),
                sha256: "a".repeat(64),
                render: Some(RenderLoop {
                    handler: "draw".into(),
                    fps: Some(12),
                    width: Some(160),
                    height: Some(140),
                }),
            });
            package.manifest.contributes.ui_regions = regions;
            package
        };
        let region = |id: &str, region_name: &str| MarketUiRegionContribution {
            region: region_name.into(),
            id: id.into(),
            title: "宠物".into(),
            order: Some(5),
            overflow: None,
            width: Some(160),
            height: Some(140),
            actions: vec![MarketRegionAction {
                id: "feed".into(),
                label: "喂食".into(),
            }],
        };

        // 合法：shellSidebar + worker render。
        assert!(validate_package(&worker_with_region(vec![region("pet", "shellSidebar")])).is_ok());

        // 声明式包带 uiRegion：拒绝。
        let mut declarative = demo_package();
        declarative.manifest.contributes.ui_regions = vec![region("pet", "shellSidebar")];
        assert!(validate_package(&declarative).is_err());

        // worker 无 render 循环：拒绝。
        let mut no_render = worker_with_region(vec![region("pet", "shellSidebar")]);
        no_render.manifest.runtime.as_mut().unwrap().render = None;
        assert!(validate_package(&no_render).is_err());

        // 未知区域：拒绝。
        assert!(validate_package(&worker_with_region(vec![region("pet", "titlebar")])).is_err());

        // 超尺寸 / 动作超限 / 重复 id：拒绝。
        let mut oversized = worker_with_region(vec![region("pet", "shellSidebar")]);
        oversized.manifest.contributes.ui_regions[0].width = Some(600);
        assert!(validate_package(&oversized).is_err());

        let mut too_many_actions = worker_with_region(vec![region("pet", "shellSidebar")]);
        too_many_actions.manifest.contributes.ui_regions[0].actions = (0..5)
            .map(|index| MarketRegionAction {
                id: format!("a{index}"),
                label: "x".into(),
            })
            .collect();
        assert!(validate_package(&too_many_actions).is_err());

        let duplicated = worker_with_region(vec![
            region("pet", "shellSidebar"),
            region("pet", "activityPanel"),
        ]);
        assert!(validate_package(&duplicated).is_err());
    }

    #[test]
    fn render_loop_validation_bounds_handler_fps_and_canvas() {
        let worker_with_render = |render: Option<RenderLoop>| {
            let mut package = demo_package();
            package.manifest.kind = PluginKind::Worker;
            package.manifest.runtime = Some(CodePluginRuntime {
                runtime_type: "worker".into(),
                entry: "https://raw.githubusercontent.com/acme/plugins/main/demo.js".into(),
                sha256: "a".repeat(64),
                render,
            });
            package
        };

        // 合法 render：handler + 默认 fps/画布。
        let ok = worker_with_render(Some(RenderLoop {
            handler: "draw".into(),
            fps: None,
            width: None,
            height: None,
        }));
        assert!(validate_package(&ok).is_ok());

        // fps 越界（0 / 61）拒绝；合法（1-60）通过。
        let mut bad_fps = worker_with_render(Some(RenderLoop {
            handler: "draw".into(),
            fps: Some(0),
            width: None,
            height: None,
        }));
        assert!(validate_package(&bad_fps).is_err());
        bad_fps
            .manifest
            .runtime
            .as_mut()
            .unwrap()
            .render
            .as_mut()
            .unwrap()
            .fps = Some(61);
        assert!(validate_package(&bad_fps).is_err());
        bad_fps
            .manifest
            .runtime
            .as_mut()
            .unwrap()
            .render
            .as_mut()
            .unwrap()
            .fps = Some(30);
        assert!(validate_package(&bad_fps).is_ok());

        // 画布越界（0 / >512）拒绝。
        let mut bad_size = worker_with_render(Some(RenderLoop {
            handler: "draw".into(),
            fps: None,
            width: Some(0),
            height: Some(100),
        }));
        assert!(validate_package(&bad_size).is_err());
        bad_size
            .manifest
            .runtime
            .as_mut()
            .unwrap()
            .render
            .as_mut()
            .unwrap()
            .width = Some(600);
        assert!(validate_package(&bad_size).is_err());

        // handler key 非法（大写/空）。
        let bad_handler = worker_with_render(Some(RenderLoop {
            handler: "Draw".into(),
            fps: None,
            width: None,
            height: None,
        }));
        assert!(validate_package(&bad_handler).is_err());
    }

    #[test]
    fn rejects_actions_and_outputs_with_invalid_field_references() {
        let mut package = demo_package();
        package.manifest.contributes.modes[0].page.outputs[0].value_key = "missing".into();
        assert!(validate_package(&package).is_err());

        let mut package = demo_package();
        package.manifest.contributes.modes[0].page.actions[0].operation =
            DeclarativeOperation::Increment {
                key: "missing".into(),
                amount: Some(1.0),
            };
        assert!(validate_package(&package).is_err());

        let mut package = demo_package();
        package.manifest.contributes.modes[0].page.fields[0].default =
            serde_json::json!("not a number");
        assert!(validate_package(&package).is_err());
    }

    #[test]
    fn installs_lists_updates_and_uninstalls_inside_root() {
        let root =
            std::env::temp_dir().join(format!("gw-plugin-market-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let package = demo_package();
        let installed = install_package_at(&root, &package).expect("install succeeds");
        assert!(installed.ends_with("demo.counter/plugin.json"));
        let listed = list_installed_at(&root).expect("list succeeds");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].manifest.id, "demo.counter");

        let mut updated = package;
        updated.manifest.version = "1.1.0".into();
        install_package_at(&root, &updated).expect("update succeeds");
        assert_eq!(
            list_installed_at(&root).unwrap()[0].manifest.version,
            "1.1.0"
        );
        std::fs::remove_dir_all(root.join("demo.counter")).unwrap();
        assert!(list_installed_at(&root).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn net_fetch_requirements_require_a_valid_host_allowlist() {
        // 无 hosts 白名单的字符串形态：拒绝。
        let mut package = demo_package();
        package.manifest.requires = vec![CapabilityRequirement::Plain("net.fetch".into())];
        assert!(validate_package(&package).is_err());

        // 参数化形态 + 合法 hosts：通过。
        let mut package = demo_package();
        package.manifest.requires = vec![CapabilityRequirement::Parameterized {
            capability: "net.fetch".into(),
            hosts: vec!["api.github.com".into(), "example.org".into()],
        }];
        assert!(validate_package(&package).is_ok());

        // 越权：net.fetch 之外的能力不接受参数。
        let mut package = demo_package();
        package.manifest.requires = vec![CapabilityRequirement::Parameterized {
            capability: "plugin-admin".into(),
            hosts: vec!["api.github.com".into()],
        }];
        assert!(validate_package(&package).is_err());

        // 非法 host：协议 / 通配 / 单标签。
        for host in ["https://api.github.com", "*.github.com", "localhost"] {
            let mut package = demo_package();
            package.manifest.requires = vec![CapabilityRequirement::Parameterized {
                capability: "net.fetch".into(),
                hosts: vec![host.into()],
            }];
            assert!(
                validate_package(&package).is_err(),
                "host {host} should be rejected"
            );
        }
    }

    #[test]
    fn plugin_net_fetch_url_validation_enforces_https_and_host_allowlist() {
        let allow = vec!["api.github.com".to_string(), "example.org".to_string()];
        // 白名单内（含子域）：通过。
        assert!(validate_plugin_fetch_url("https://api.github.com/meta", &allow).is_ok());
        assert!(validate_plugin_fetch_url("https://www.example.org/", &allow).is_ok());
        // 白名单外：拒绝。
        assert!(validate_plugin_fetch_url("https://evil.com/", &allow).is_err());
        // 后缀伪造：允许 example.org 不等于允许 notexample.org。
        assert!(validate_plugin_fetch_url("https://notexample.org/", &allow).is_err());
        // 非 https / 内嵌凭据 / 空白名单：拒绝。
        assert!(validate_plugin_fetch_url("http://api.github.com/", &allow).is_err());
        assert!(validate_plugin_fetch_url("https://user:pass@api.github.com/", &allow).is_err());
        assert!(validate_plugin_fetch_url("https://api.github.com/", &[]).is_err());
    }

    #[test]
    fn registry_signature_policy_official_missing_forged_and_valid() {
        use base64::Engine;
        use ed25519_dalek::{Signer, SigningKey};

        fn registry_with(signature: Option<String>) -> PluginRegistry {
            PluginRegistry {
                schema_version: 1,
                plugins: vec![PluginRegistryEntry {
                    id: "demo.counter".into(),
                    name: "Demo Counter".into(),
                    version: "1.0.0".into(),
                    description: None,
                    author: None,
                    download_url: "https://raw.githubusercontent.com/acme/plugins/main/demo.json"
                        .into(),
                    sha256: "a".repeat(64),
                }],
                signature,
            }
        }

        // RFC 8032 测试向量私钥（公钥 3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c）。
        let signing_key = SigningKey::from_bytes(
            &hex_decode_32("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
                .unwrap(),
        );
        let public_key_bytes = signing_key.verifying_key().to_bytes();
        let official_url =
            "https://raw.githubusercontent.com/jean3690/greywork-plugin-market/main/registry.json";
        let third_party_url =
            "https://raw.githubusercontent.com/someone/other-market/main/registry.json";

        // 签名消息 = 去掉 signature 字段后的规范化 JSON（与 verify 端约定一致）。
        let message = serde_json::to_vec(&registry_with(None)).unwrap();
        let good_signature =
            base64::engine::general_purpose::STANDARD.encode(signing_key.sign(&message).to_bytes());

        // 1) 官方源 + 缺签名：拒绝。
        assert!(validate_registry(&registry_with(None), official_url).is_err());
        // 2) 自建源 + 缺签名：放行（用户自担）。
        assert!(validate_registry(&registry_with(None), third_party_url).is_ok());

        // 3) 伪造签名（攻击者私钥）：对任意 URL 都拒绝。
        let mut attacker_seed = [0u8; 32];
        attacker_seed[0] = 1;
        let attacker_key = SigningKey::from_bytes(&attacker_seed);
        let forged = base64::engine::general_purpose::STANDARD
            .encode(attacker_key.sign(&message).to_bytes());
        assert!(
            verify_registry_signature_with(&registry_with(Some(forged)), &public_key_bytes)
                .is_err()
        );

        // 4) 正确签名（对注入公钥）：验签通过。
        assert!(verify_registry_signature_with(
            &registry_with(Some(good_signature.clone())),
            &public_key_bytes
        )
        .is_ok());

        // 5) 内容篡改：签名后改 plugins 内容 → 验签失败。
        let mut tampered = registry_with(Some(good_signature));
        tampered.plugins[0].version = "9.9.9".into();
        assert!(verify_registry_signature_with(&tampered, &public_key_bytes).is_err());

        // 6) 非法 base64 / 错误长度。
        assert!(verify_registry_signature_with(
            &registry_with(Some("!!!not-base64!!!".into())),
            &public_key_bytes
        )
        .is_err());
        assert!(verify_registry_signature_with(
            &registry_with(Some("AAAA".into())),
            &public_key_bytes
        )
        .is_err());
    }

    #[test]
    fn shipped_registry_verifies_against_host_public_key() {
        // 端到端信任链自检：plugin-market/registry.json 的签名必须能被
        // 宿主硬编码公钥验过 —— 防止签名脚本与 Rust 验签端规范化不一致。
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../plugin-market/registry.json"
        );
        let Ok(bytes) = std::fs::read(path) else {
            // 仓库外构建（仅 src-tauri 目录）跳过。
            return;
        };
        let registry: PluginRegistry = serde_json::from_slice(&bytes).expect("registry parses");
        let public_key = hex_decode_32(OFFICIAL_REGISTRY_PUBLIC_KEY).expect("host key decodes");
        verify_registry_signature_with(&registry, &public_key)
            .expect("shipped registry signature verifies");
    }

    #[test]
    fn shipped_market_packages_pass_validation() {
        // 市场目录内所有包必须过 validate_package + 与 registry 条目身份一致 ——
        // 发布前忘了重算 sha256 / 改坏了 schema 在这里炸，而不是用户安装时。
        let market_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../plugin-market");
        let registry_path = format!("{market_dir}/registry.json");
        let Ok(registry_bytes) = std::fs::read(&registry_path) else {
            return;
        };
        let registry: PluginRegistry =
            serde_json::from_slice(&registry_bytes).expect("registry parses");
        for entry in &registry.plugins {
            let file_name = entry
                .download_url
                .rsplit('/')
                .next()
                .expect("download url has file name");
            let bytes = std::fs::read(format!("{market_dir}/packages/{file_name}"))
                .unwrap_or_else(|_| panic!("package file exists: {file_name}"));
            let package: PluginPackage = serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| panic!("package parses: {file_name}"));
            validate_package(&package)
                .unwrap_or_else(|error| panic!("package validates ({file_name}): {error}"));
            assert_eq!(package.manifest.id, entry.id, "package id matches registry");
            assert_eq!(
                package.manifest.version, entry.version,
                "package version matches registry"
            );
            let actual_hash = format!("{:x}", Sha256::digest(&bytes));
            assert_eq!(
                actual_hash, entry.sha256,
                "package sha256 matches registry ({file_name})"
            );
        }
    }
}
