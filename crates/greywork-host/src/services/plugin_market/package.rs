//! manifest 与包的整体校验（能力、区域、窗口声明）。

use super::dto::{CapabilityRequirement, DeclarativeOperation, MarketPluginManifest, PluginKind};
use super::validate::{
    validate_dir_key, validate_github_url, validate_key, validate_page, validate_sha256,
    validate_version,
};

pub(super) fn validate_requirement(requirement: &CapabilityRequirement) -> Result<(), String> {
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

/// manifest 是否声明了 `window.floating` 能力。
///
/// 悬浮窗由宿主托管，但「能开窗」这件事必须在 manifest 里显式声明（用户据此知情授权）；
/// `validate_package` 强制 window 声明与 requires 一致，宿主开窗命令再以此做纵深校验。
pub fn declares_window_floating(manifest: &MarketPluginManifest) -> bool {
    manifest
        .requires
        .iter()
        .any(|requirement| match requirement {
            CapabilityRequirement::Plain(capability) => capability == "window.floating",
            CapabilityRequirement::Parameterized { capability, .. } => {
                capability == "window.floating"
            }
        })
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

pub(super) fn validate_package(package: &super::dto::PluginPackage) -> Result<(), String> {
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
        if mode.title.len() > 120 {
            return Err(format!("mode {} title exceeds 120 characters", mode.id));
        }
        if mode.page.heading.len() > 160 {
            return Err(format!("mode {} heading exceeds 160 characters", mode.id));
        }
        if mode
            .page
            .eyebrow
            .as_deref()
            .is_some_and(|eyebrow| eyebrow.len() > 120)
        {
            return Err(format!("mode {} eyebrow exceeds 120 characters", mode.id));
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
        // invoke 动作要在 worker 里执行 —— 声明式包不得引用（拒绝而非静默忽略）。
        if has_invoke && manifest.kind != PluginKind::Worker {
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
        // 脱窗是受控能力：声明窗口就必须同时声明 window.floating（用户授权门禁的输入）。
        if !declares_window_floating(manifest) {
            return Err(
                "window declaration requires the window.floating capability in requires"
                    .to_string(),
            );
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
