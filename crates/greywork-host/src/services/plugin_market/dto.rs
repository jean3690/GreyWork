//! registry / package / manifest 的 serde 类型。

use serde::{Deserialize, Serialize};

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
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginWindowDecl {
    pub width: u32,
    pub height: u32,
}

/// manifest `requires` 项：字符串 = 无参数；对象 = 带资源参数
/// （net.fetch 的 hosts / methods / paths / maxBytes 白名单；schedule 的定时参数；
/// llm.chat 的 models 模型白名单；clipboard 的 ops 操作子集）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum CapabilityRequirement {
    Plain(String),
    Parameterized {
        capability: String,
        #[serde(default)]
        hosts: Vec<String>,
        /// net.fetch 专属：允许的 HTTP 方法子集（缺省 = `GET`/`HEAD`）。
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        methods: Vec<String>,
        /// net.fetch 专属：`POST` 允许的路径模板（仅当声明了 `POST` 时必填）。
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        paths: Vec<String>,
        /// net.fetch 专属：单次上下行字节上限（缺省 1 MiB，封顶 8 MiB）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_bytes: Option<u32>,
        /// schedule 能力专属：定时参数（其它能力不得携带）。
        #[serde(default)]
        schedule: Option<ManifestSchedule>,
        /// llm.chat 专属：允许调用的模型白名单（其它能力不得携带）。
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        models: Vec<String>,
        /// clipboard 专属：允许的操作子集（`read` / `write`；缺省等于只允许 write）。
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        ops: Vec<String>,
    },
}

/// schedule 能力的定时参数：`{ "kind": "interval", "min": 60 }`。
/// 执行侧（工作台调度器）按 min 分钟为周期唤醒 worker 的 registerSchedule 处理器。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ManifestSchedule {
    pub kind: ManifestScheduleKind,
    pub min: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ManifestScheduleKind {
    /// 固定间隔（分钟）：宿主按周期唤醒；挂载面不在内存时跳过，下次激活补结算一次。
    Interval,
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
    /// 指针回传：声明 true 时宿主把画布指针事件（down/move/up/cancel/leave）归一化后
    /// 交给 worker 的 `registerPointer` 处理器；缺省 false（老包不受影响）。
    #[serde(default)]
    pub pointer: bool,
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
