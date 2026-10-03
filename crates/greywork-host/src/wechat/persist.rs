use std::path::{Path, PathBuf};
use std::sync::Arc;

use reqwest::Url;
use wechatbot::Credentials;

use crate::channel_common::{channel_dir, read_json, write_private};
use crate::channel_media::inbox_dir;
use crate::host::HostContext;
use crate::log;

use super::*;

/* ===== 宿主层：目录与凭证 ===== */

pub(super) fn wechat_dir(host_ctx: &Arc<dyn HostContext>) -> Result<PathBuf, String> {
    channel_dir(host_ctx.as_ref(), DIR_NAME)
}

/// 微信的入站媒体收件目录（实现在 channel_media，目录名即通道名）。
pub(super) fn wechat_inbox_dir(host_ctx: &Arc<dyn HostContext>) -> Result<PathBuf, String> {
    inbox_dir(host_ctx.as_ref(), DIR_NAME)
}

/// 校验并归一化 SDK 登录下发的 `baseurl`：必须是 https 且主机名归属 `qq.com`。
///
/// SDK 自己不校验这个地址，而后续所有请求（含 bot_token）都打到它上面 —— 这道闸必须在宿主侧。
pub(super) fn trusted_api_base(raw: &str) -> Result<String, String> {
    let parsed = Url::parse(raw.trim()).map_err(|error| format!("登录下发的地址非法: {error}"))?;
    if parsed.scheme() != "https" {
        return Err(format!("登录下发的地址必须是 https：{raw}"));
    }
    let host = parsed.host_str().unwrap_or_default();
    if host != "qq.com" && !host.ends_with(".qq.com") {
        return Err(format!("登录下发的主机不在 qq.com 域内：{host}"));
    }
    Ok(parsed.to_string())
}

/// 读 SDK 落的凭证。缺失 / 损坏 / 主机不可信一律当作「未登录」，并把不可用的文件删掉
/// （留着只会让下一次登录在 SDK 内部解析失败，报出一个与现场不符的错）。
pub(super) fn read_creds(path: &Path) -> Option<Credentials> {
    if !path.exists() {
        return None;
    }
    let parsed: Option<Credentials> = read_json(path);
    let Some(creds) = parsed else {
        log::warn("wechat", "凭证文件无法解析，按未登录处理并删除");
        let _ = std::fs::remove_file(path);
        return None;
    };
    if creds.token.trim().is_empty() {
        log::warn("wechat", "凭证文件缺少 token，按未登录处理并删除");
        let _ = std::fs::remove_file(path);
        return None;
    }
    if let Err(error) = trusted_api_base(&creds.base_url) {
        log::warn("wechat", format!("凭证里的登录地址不可信，丢弃: {error}"));
        let _ = std::fs::remove_file(path);
        return None;
    }
    Some(creds)
}

/// 首次触碰时把磁盘上的凭证读进内存。
pub(super) fn ensure_loaded(handles: &HostHandles, inner: &mut Inner) {
    if inner.loaded {
        return;
    }
    inner.creds = read_creds(&handles.cred_path);
    inner.state = "stopped".into();
    inner.loaded = true;
}

/// 把 SDK 写的凭证收紧到 0600（SDK 用默认权限写，项目约定是 0600）。
pub(super) fn harden_credentials(path: &Path) {
    let Ok(bytes) = std::fs::read(path) else {
        return;
    };
    if let Err(error) = write_private(path, &bytes) {
        log::warn("wechat", format!("收紧凭证权限失败: {error}"));
    }
}
