//! registry 校验与 ed25519 签名验证。

use super::dto::PluginRegistry;
use super::validate::{validate_github_url, validate_key, validate_sha256, validate_version};
use super::{OFFICIAL_REGISTRY_PUBLIC_KEY, OFFICIAL_REGISTRY_URL};

pub(super) fn validate_registry(
    registry: &PluginRegistry,
    registry_url: &str,
) -> Result<(), String> {
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
/// registry URL 的规范形态：仅保留 scheme://host/path（host 小写、去结尾斜杠、
/// 丢弃 query/fragment）。用于「是否官方源」判定 —— 否则 `.../registry.json?x=1`
/// 这类变体会被当成第三方源，从而绕过官方源的强制签名。
fn canonical_registry_url(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw.trim()).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    Some(format!(
        "{}://{}{}",
        url.scheme().to_ascii_lowercase(),
        host,
        url.path().trim_end_matches('/')
    ))
}

pub(super) fn is_official_registry_url(raw: &str) -> bool {
    match (
        canonical_registry_url(raw),
        canonical_registry_url(OFFICIAL_REGISTRY_URL),
    ) {
        (Some(candidate), Some(official)) => candidate == official,
        _ => false,
    }
}

fn verify_registry_signature(registry: &PluginRegistry, registry_url: &str) -> Result<(), String> {
    let is_official = is_official_registry_url(registry_url);
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

pub(super) fn verify_registry_signature_with(
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

pub(super) fn hex_decode_32(input: &str) -> Result<[u8; 32], ()> {
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
