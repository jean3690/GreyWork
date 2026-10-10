//! 键名 / 版本 / URL / sha256 / 页面 schema 的基础校验。

use super::dto::{DeclarativeOperation, DeclarativePage};
use super::ALLOWED_GITHUB_HOSTS;

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

pub(super) fn validate_version(raw: &str) -> Result<(), String> {
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

pub(super) fn validate_github_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|error| format!("invalid GitHub URL: {error}"))?;
    let host = url.host_str().unwrap_or_default();
    if url.scheme() != "https" || !ALLOWED_GITHUB_HOSTS.contains(&host) {
        return Err(format!(
            "plugin market URL must use HTTPS on an allowed GitHub host: {raw}"
        ));
    }
    Ok(url)
}

pub(super) fn validate_sha256(raw: &str) -> Result<(), String> {
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

pub(super) fn validate_page(mode_id: &str, page: &DeclarativePage) -> Result<(), String> {
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
