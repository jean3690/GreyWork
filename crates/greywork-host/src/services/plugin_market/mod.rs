//! 插件市场宿主。
//!
//! 注册表与插件包来自 GitHub HTTPS。声明式包只包含受限 JSON；代码包额外下载一个
//! SHA-256 固定的 ES module，并仅在 Web Worker 中执行。安装前校验来源、体积、身份、
//! schema 与持久化键；落盘到 `<app_data>/plugins/<plugin-id>/`。
//!
//! # 子模块
//!
//! - [`dto`]：registry / package / manifest 的 serde 类型；
//! - [`validate`]：键名 / 版本 / URL / sha256 / 页面 schema 的基础校验；
//! - [`package`]：manifest 与包的整体校验（能力、区域、窗口声明）；
//! - [`registry`]：registry 校验与 ed25519 签名验证；
//! - [`http`]：限额下载（读取上限 + 超时）；
//! - [`install`]：安装 / 列举 / 拉取校验；
//! - [`commands`]：对外命令（catalog / preview / install / list / uninstall）；
//! - [`net_fetch`]：前端 net.fetch 能力的宿主侧代理；
//! - [`plugin_fs`]：前端 fs.scoped 能力的宿主侧沙箱；
//! - [`plugin_notify`]：前端 notify 能力的宿主侧校验与归属合成（投递在桌面壳）。

mod commands;
mod dto;
mod http;
mod install;
mod net_fetch;
mod package;
mod plugin_fs;
mod plugin_notify;
mod registry;
mod validate;

#[cfg(test)]
mod tests;

pub use commands::{
    plugin_market_catalog, plugin_market_install, plugin_market_list_installed,
    plugin_market_preview, plugin_market_uninstall, CatalogArgs, InstallArgs, PreviewArgs,
    UninstallArgs,
};
pub use dto::{
    CapabilityRequirement, CodePluginRuntime, DeclarativeAction, DeclarativeContributions,
    DeclarativeField, DeclarativeMode, DeclarativeOperation, DeclarativeOutput, DeclarativePage,
    ManifestSchedule, ManifestScheduleKind, MarketPluginManifest, MarketRegionAction,
    MarketUiRegionContribution, PluginInstallReport, PluginKind, PluginPackage, PluginRegistry,
    PluginRegistryEntry, PluginWindowDecl, RenderLoop,
};
pub use net_fetch::{plugin_net_fetch, PluginFetchRequest, PluginFetchResponse};
pub use package::declares_window_floating;
pub use plugin_fs::{plugin_fs, PluginFsEntry, PluginFsOp, PluginFsRequest, PluginFsResponse};
pub use plugin_notify::{compose_plugin_notify, PluginNotifyRequest, PluginNotifyResponse};
pub use validate::{validate_dir_key, validate_key};

use std::time::Duration;

const MAX_REGISTRY_BYTES: usize = 512 * 1024;
const MAX_PACKAGE_BYTES: usize = 512 * 1024;
const MAX_CODE_BYTES: usize = 1024 * 1024;
/// net.fetch 未声明 `maxBytes` 时的默认上下行字节上限（1 MiB）。
const DEFAULT_PLUGIN_FETCH_BYTES: usize = 1024 * 1024;
/// net.fetch `maxBytes` 声明下界（1 KiB）：低于此值无实际用途。
const MIN_PLUGIN_FETCH_BYTES: usize = 1024;
/// net.fetch `maxBytes` 声明硬上限（8 MiB）：纵深防御，声明再大也封顶。
const MAX_PLUGIN_FETCH_BYTES_CEILING: usize = 8 * 1024 * 1024;
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
