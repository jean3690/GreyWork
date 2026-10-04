//! 云端 Office 预览：把工作区里的文件交给厂商 API，换回一个可嵌入的文档地址。
//!
//! **为什么是「宿主上传」而不是「宿主暴露签名 URL 让云端来拉」**：桌面端默认在 NAT 后面，
//! 厂商服务器根本连不到本机；服务端虽然可能有公网地址，但那要求用户额外配反代与签名出口。
//! 由宿主把文件推上去，两个宿主（桌面 / headless 服务端）走的是同一条路径。
//!
//! 设计约束：
//! - **凭证只在宿主从环境变量解析**（与 `llm.rs` 同一套边界）。渲染端只传变量名与配方，
//!   设置快照、IPC 载荷、日志里都不会出现密钥。
//! - **配方是受限数据，不是代码**：只描述「往哪发、怎么发、从响应哪里取 URL」，
//!   与 plugin-market 的声明式插件同一套哲学。四个预设厂商共用同一份实现逻辑，
//!   「自定义」因此不需要改代码。
//! - **文件不经渲染端中转**：宿主凭路径读，授权校验与 20MB 上限都收在
//!   [`crate::workspace_fs::fs_read_binary`] 一处；几 MB 的文件 base64 过 IPC 纯属浪费。
//!
//! 失败一律**不静默降级**：这里返回 `Err`，由渲染端决定回落本地 viewer 并把原因显示出来。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::workspace_fs::{self, WorkspaceFsAccess};

/// 包体形态：整文件原始字节。
const BODY_RAW: &str = "raw-bytes";
/// 包体形态：multipart 表单。
const BODY_MULTIPART: &str = "multipart";

/// 上传失败诊断里错误体的截断长度（按字符，避免切坏中文）。
const ERROR_BODY_CHARS: usize = 200;

/// 云端 Office 上传取件的声明式配方（与前端 `packages/shell/src/services.ts` 的 `OfficeRecipe` 对齐）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeRecipe {
    /// HTTP 方法，只放行 `POST` / `PUT`。
    pub method: String,
    /// 请求地址模板；`{filename}` 会被替换为 URL 编码后的文件名。
    pub url: String,
    /// 包体形态：`raw-bytes`（整文件字节）或 `multipart`（表单）。
    pub body: String,
    /// `multipart` 时的文件字段名；缺省 `file`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_field: Option<String>,
    /// `raw-bytes` 时的 Content-Type；缺省按扩展名推断。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    /// 凭证请求头模板（支持 `{{ENV_VAR}}` 占位符），如 `Authorization: Bearer {{MSGRAPH_ACCESS_TOKEN}}`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_header: Option<String>,
    /// 从响应 JSON 取文档地址的 JSON 指针，如 `/webUrl`。
    pub view_url_pointer: String,
}

/// `office_preview_open` 的入参。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewOpenArgs {
    /// 工作区内的文件路径（由 `WorkspaceFsAccess` 解析并校验授权根）。
    pub path: String,
    /// 上传取件配方。
    pub recipe: OfficeRecipe,
    /// 凭证所在的**环境变量名**；空/缺省 = 该服务不需要凭证。
    #[serde(default)]
    pub credential_env: Option<String>,
    /// 附加请求头（值支持 `{{ENV_VAR}}` 占位符）。
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
}

/// `office_preview_open` 的结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    /// 可嵌入的文档地址（渲染端放进 iframe）。
    pub url: String,
    /// 上传时用的文件名（UI 展示与诊断）。
    pub filename: String,
}

/* ===== 纯逻辑（便于单测，不碰网络与文件系统） ===== */

/// 取路径末段文件名（兼容 Windows 分隔符与结尾斜杠）。
pub fn filename_of(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .find(|segment| !segment.is_empty())
        .unwrap_or(path)
        .to_string()
}

/// 按 URL 路径段规则编码：只放行 unreserved 字符（RFC 3986），其余一律 `%XX`。
///
/// 不能直接用 `form_urlencoded`：那是**表单**编码，空格会变成 `+`，
/// 而 `+` 在 URL 路径段里是合法字符、不会被服务端还原成空格 —— 文件名里的空格会静默变味。
fn encode_path_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let character = *byte as char;
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '~') {
            out.push(character);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 渲染请求地址模板：`{filename}` → URL 编码后的文件名。
pub fn render_url(template: &str, filename: &str) -> String {
    template.replace("{filename}", &encode_path_segment(filename))
}

/// 按扩展名猜 Content-Type（配方没显式给时用）。认不出按八位字节流 —— 这是唯一诚实的兜底，
/// 猜一个具体类型反而会让服务端按错误类型处理。
pub fn content_type_for(filename: &str) -> &'static str {
    let extension = filename
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pdf" => "application/pdf",
        "csv" => "text/csv",
        _ => "application/octet-stream",
    }
}

/// 归一化 JSON 指针：`serde_json` 只认以 `/` 开头（或空串）的指针，
/// 而用户在设置页里十有八九会写成 `webUrl` 或 `data.url`。补一个前导斜杠，
/// 比返回一句「指针无效」有用得多。
fn normalize_pointer(pointer: &str) -> String {
    let trimmed = pointer.trim();
    if trimmed.is_empty() || trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

/// 从响应 JSON 取文档地址。
pub fn extract_view_url(body: &Value, pointer: &str) -> Result<String, String> {
    let normalized = normalize_pointer(pointer);
    let found = body
        .pointer(&normalized)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty());
    match found {
        Some(url) => Ok(url.to_string()),
        None => Err(format!(
            "响应里取不到文档地址：JSON 指针 `{normalized}` 未命中，或命中的不是非空字符串\
             （请对照厂商文档核对 viewUrlPointer）"
        )),
    }
}

/// 配方自检：在发起网络请求**之前**把明显不可用的配方拦掉。
///
/// 放在前面是有意的：配错 URL / 方法的表现若留到运行时，是「上传失败 (404)」这种
/// 什么都说明不了的错；在这里拦下来才能指出到底哪一项不对。
pub fn validate_recipe(recipe: &OfficeRecipe) -> Result<(), String> {
    let method = recipe.method.trim().to_ascii_uppercase();
    if method != "POST" && method != "PUT" {
        return Err(format!(
            "配方 method 只支持 POST / PUT，收到 `{}`",
            recipe.method
        ));
    }
    let url = recipe.url.trim();
    if url.is_empty() {
        return Err("配方 url 为空".into());
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("配方 url 必须是 http(s) 地址".into());
    }
    let body = recipe.body.trim();
    if body != BODY_RAW && body != BODY_MULTIPART {
        return Err(format!(
            "配方 body 只支持 {BODY_RAW} / {BODY_MULTIPART}，收到 `{}`",
            recipe.body
        ));
    }
    if recipe.view_url_pointer.trim().is_empty() {
        return Err("配方 viewUrlPointer 为空（不知道该从响应哪里取文档地址）".into());
    }
    Ok(())
}

/// 拆「请求头模板」（`Name: value`）为 `(名, 值模板)`。空模板 → `None`。
fn split_header_template(template: &str) -> Result<Option<(String, String)>, String> {
    let trimmed = template.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let hint = "（应形如 `Authorization: Bearer {{YOUR_TOKEN_ENV}}`）";
    match trimmed.split_once(':') {
        Some((name, value)) => {
            let name = name.trim();
            if name.is_empty() {
                return Err(format!("凭证请求头模板缺少头名{hint}"));
            }
            Ok(Some((name.to_string(), value.trim().to_string())))
        }
        None => Err(format!("凭证请求头模板缺少冒号{hint}")),
    }
}

/// 凭证预检：声明了变量名却没设值 → 直接给出可操作的错误，
/// 而不是让请求带着空头去撞 401（那时用户看到的是「上传失败 (401)」）。
fn ensure_credential(credential_env: Option<&str>) -> Result<(), String> {
    let name = credential_env.unwrap_or_default().trim();
    if name.is_empty() {
        return Ok(()); // 本地 / 无鉴权服务
    }
    if std::env::var(name).unwrap_or_default().is_empty() {
        return Err(format!(
            "未设置云端 Office 凭证：先在本机终端执行 {}，再从同一终端启动 GreyWork\
             （设置页 → 服务 可查看/修改变量名）",
            crate::llm::env_set_hint(name, cfg!(windows))
        ));
    }
    Ok(())
}

/* ===== 宿主侧事实查询 ===== */

/// 桌面壳**静态** CSP 里放行的 `frame-src` 来源（三个预设厂商的文档域名）。
///
/// 桌面端的 CSP 写死在 `tauri.conf.json`（运行期改不了），所以「能不能内嵌某个地址」
/// 在桌面端不取决于配置，而取决于这张表。headless 服务端的 CSP 是启动时按配置生成的
/// （见 `apps/server/src/middleware.rs`），不受此表约束。
///
/// **这张表必须与 `apps/desktop/src-tauri/tauri.conf.json` 的 `frame-src` 一致** ——
/// 桌面壳的漂移测试会读该文件逐项比对，只改一处会红。
///
/// 自定义配方因此有两个落点差异，前端要如实呈现（而不是让 iframe 白屏）：
/// 桌面端不内嵌非本表来源，服务端则随配置放行。
///
/// 桌面包装把它作为 [`host_info`] 的入参回给渲染端；服务端则传自己的 `frame_origins`。
pub const EMBEDDABLE_FRAME_ORIGINS: &[&str] = &[
    "https://www.kdocs.cn",
    "https://docs.qq.com",
    "https://view.officeapps.live.com",
];

/// `office_host_info` 的入参。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfoArgs {
    /// 要查询凭证变量是否已设置的变量名清单（渲染端从自己的服务配置里收集）。
    #[serde(default)]
    pub env_names: Vec<String>,
}

/// `office_host_info` 的结果：渲染端渲染服务设置面所需、且只有宿主知道的事实。
///
/// 注意这里回的是**变量名是否已设置**，不是值 —— 密钥永不回渲染端。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    /// **本宿主** CSP 允许内嵌的 origin（已归一化）：桌面 = [`EMBEDDABLE_FRAME_ORIGINS`] 静态表；
    /// headless 服务端 = `GREYWORK_FRAME_ORIGINS` 配置。
    ///
    /// 渲染端据此判断厂商返回的文档地址能不能真的进 iframe —— 不在表里就是被 CSP 拦掉、
    /// 白屏且控制台之外看不到报错，所以宁可提前回落本地 viewer 并把原因说出来。
    pub embeddable_frame_origins: Vec<String>,
    /// 已设置（非空）的环境变量名。
    pub env_present: Vec<String>,
    /// 声明了但未设置的环境变量名 —— 设置页据此给出「先 export」的提示，
    /// 免得用户第一次预览才撞上失败。
    pub env_missing: Vec<String>,
}

/// 查询宿主侧事实。纯读，不发网络请求。
///
/// `embeddable_frame_origins` 由宿主注入自己的真值（见 [`HostInfo::embeddable_frame_origins`]）：
/// 这份白名单只存在于宿主侧（桌面写死在打包配置、服务端来自启动配置），共享层无从得知，
/// 所以由调用方传进来，这里只负责归一化与回显。
pub fn host_info(embeddable_frame_origins: &[String], args: HostInfoArgs) -> HostInfo {
    let mut env_present = Vec::new();
    let mut env_missing = Vec::new();
    for name in args.env_names {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        if std::env::var(name).unwrap_or_default().is_empty() {
            env_missing.push(name.to_string());
        } else {
            env_present.push(name.to_string());
        }
    }
    env_present.dedup();
    env_missing.dedup();
    HostInfo {
        embeddable_frame_origins: normalize_frame_origins(embeddable_frame_origins),
        env_present,
        env_missing,
    }
}

/// 批量归一化 + 去重（保序）。非法项静默丢弃 —— 服务端拼 CSP 时已就同一批配置打过启动告警，
/// 这里再报一遍只会刷屏。
fn normalize_frame_origins(origins: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for origin in origins {
        if let Ok(normalized) = crate::csp::normalize_frame_origin(origin) {
            if !out.contains(&normalized) {
                out.push(normalized);
            }
        }
    }
    out
}

/* ===== 命令实现 ===== */

/// 上传工作区文件并取回可嵌入的文档地址。
///
/// 错误分三类，都带可操作的说明：配方不合法（配置页填错）、凭证缺失（环境变量）、
/// 厂商返回失败（URL 或响应结构对不上）。
pub async fn open_preview(
    workspace: &WorkspaceFsAccess,
    args: PreviewOpenArgs,
) -> Result<PreviewResult, String> {
    validate_recipe(&args.recipe)?;
    ensure_credential(args.credential_env.as_deref())?;

    let bytes = workspace_fs::fs_read_binary(workspace, args.path.clone())?;
    let filename = filename_of(&args.path);
    let url = render_url(args.recipe.url.trim(), &filename);

    let content_type = args
        .recipe
        .content_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| content_type_for(&filename).to_string());

    let client = crate::http::shared_client(10)?;
    let mut request = if args.recipe.method.trim().eq_ignore_ascii_case("PUT") {
        client.put(&url)
    } else {
        client.post(&url)
    };

    for (key, value) in args.headers.iter().flatten() {
        request = request.header(key, crate::llm::resolve_header_placeholders(value)?);
    }
    if let Some((name, value)) =
        split_header_template(args.recipe.credential_header.as_deref().unwrap_or_default())?
    {
        request = request.header(name, crate::llm::resolve_header_placeholders(&value)?);
    }

    // 包体：multipart 用于多数国内厂商的「上传文件」接口，raw-bytes 用于
    // Microsoft Graph 那类「PUT 整文件到路径」的接口。
    request = if args.recipe.body.trim() == BODY_MULTIPART {
        let field = args
            .recipe
            .file_field
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("file");
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(filename.clone())
            .mime_str(&content_type)
            .map_err(|error| format!("Content-Type 不合法（{content_type}）: {error}"))?;
        request.multipart(reqwest::multipart::Form::new().part(field.to_string(), part))
    } else {
        request.header("content-type", content_type).body(bytes)
    };

    let response = request
        .send()
        .await
        .map_err(|error| format!("云端 Office 上传失败（网络层）: {error}"))?;
    let status = response.status();
    let text = crate::http::read_text(response, crate::http::RESPONSE_READ_TIMEOUT).await?;
    if !status.is_success() {
        return Err(format!(
            "云端 Office 上传失败 ({status})：{}",
            crate::llm::truncate(&text, ERROR_BODY_CHARS)
        ));
    }
    let body: Value = serde_json::from_str(&text).map_err(|error| {
        format!(
            "云端 Office 响应不是 JSON: {error}（响应体：{}）",
            crate::llm::truncate(&text, ERROR_BODY_CHARS)
        )
    })?;
    let view_url = extract_view_url(&body, &args.recipe.view_url_pointer)?;
    Ok(PreviewResult {
        url: view_url,
        filename,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn recipe() -> OfficeRecipe {
        OfficeRecipe {
            method: "POST".into(),
            url: "https://docs.example.com/upload?name={filename}".into(),
            body: BODY_MULTIPART.into(),
            file_field: None,
            content_type: None,
            credential_header: Some("Authorization: Bearer {{GREYWORK_TEST_OFFICE_TOKEN}}".into()),
            view_url_pointer: "/data/url".into(),
        }
    }

    #[test]
    fn filename_of_handles_both_separators_and_trailing_slash() {
        assert_eq!(filename_of("/home/u/报告.docx"), "报告.docx");
        assert_eq!(filename_of("C:\\Users\\u\\a.xlsx"), "a.xlsx");
        assert_eq!(filename_of("/home/u/dir/"), "dir", "结尾斜杠取上一段");
        assert_eq!(filename_of("plain.txt"), "plain.txt");
    }

    #[test]
    fn render_url_encodes_chinese_and_spaces() {
        let url = render_url("https://x.example.com/u?s={filename}", "季度 报告.docx");
        assert!(
            url.contains("%E5%AD%A3%E5%BA%A6"),
            "中文被百分号编码：{url}"
        );
        assert!(url.contains("%20"), "空格编码为 %20（不是 +）：{url}");
        assert!(!url.contains(' '), "渲染后不应残留裸空格");
        assert!(url.ends_with(".docx"), "扩展名与点号保持原样：{url}");
    }

    #[test]
    fn render_url_keeps_template_without_placeholder() {
        assert_eq!(
            render_url("https://x.example.com/u", "a.docx"),
            "https://x.example.com/u"
        );
    }

    #[test]
    fn content_type_follows_extension() {
        assert_eq!(
            content_type_for("a.docx"),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        assert_eq!(
            content_type_for("a.XLSX"),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        assert_eq!(content_type_for("a.doc"), "application/msword");
        assert_eq!(content_type_for("a.unknownext"), "application/octet-stream");
        assert_eq!(content_type_for("noext"), "application/octet-stream");
    }

    #[test]
    fn extract_view_url_hits_pointer() {
        let body = json!({ "data": { "url": "https://docs.example.com/d/1" } });
        assert_eq!(
            extract_view_url(&body, "/data/url").unwrap(),
            "https://docs.example.com/d/1"
        );
    }

    #[test]
    fn extract_view_url_tolerates_pointer_without_leading_slash() {
        let body = json!({ "webUrl": "https://docs.example.com/d/2" });
        assert_eq!(
            extract_view_url(&body, "webUrl").unwrap(),
            "https://docs.example.com/d/2",
            "用户常写成 webUrl 而非 /webUrl"
        );
    }

    #[test]
    fn extract_view_url_rejects_miss_and_blank() {
        let body = json!({ "data": { "url": "   " } });
        let error = extract_view_url(&body, "/data/url").unwrap_err();
        assert!(
            error.contains("/data/url"),
            "错误里要带上指针，便于对照配置：{error}"
        );
        assert!(extract_view_url(&json!({}), "/data/url").is_err());
        assert!(extract_view_url(&body, "/data/missing").is_err());
    }

    #[test]
    fn validate_recipe_accepts_the_documented_shape() {
        assert!(validate_recipe(&recipe()).is_ok());
    }

    #[test]
    fn validate_recipe_rejects_each_bad_field() {
        let mut bad = recipe();
        bad.method = "DELETE".into();
        assert!(validate_recipe(&bad).unwrap_err().contains("method"));

        let mut bad = recipe();
        bad.url = "file:///etc/passwd".into();
        assert!(validate_recipe(&bad).unwrap_err().contains("http(s)"));

        let mut bad = recipe();
        bad.url = "  ".into();
        assert!(validate_recipe(&bad).unwrap_err().contains("url 为空"));

        let mut bad = recipe();
        bad.body = "json".into();
        assert!(validate_recipe(&bad).unwrap_err().contains("body"));

        let mut bad = recipe();
        bad.view_url_pointer = " ".into();
        assert!(validate_recipe(&bad)
            .unwrap_err()
            .contains("viewUrlPointer"));
    }

    #[test]
    fn split_header_template_parses_and_rejects() {
        let (name, value) = split_header_template("Authorization: Bearer {{TOKEN}}")
            .unwrap()
            .expect("some");
        assert_eq!(name, "Authorization");
        assert_eq!(value, "Bearer {{TOKEN}}");
        assert!(split_header_template("   ").unwrap().is_none());
        assert!(split_header_template("Authorization")
            .unwrap_err()
            .contains("冒号"));
        assert!(split_header_template(": value")
            .unwrap_err()
            .contains("头名"));
    }

    /// 未设凭证变量 —— 报错要指路到具体的环境变量名与设置页。
    #[test]
    fn ensure_credential_reports_missing_env() {
        assert!(ensure_credential(None).is_ok(), "无凭证服务放行");
        assert!(ensure_credential(Some("  ")).is_ok(), "空名视为无凭证");
        let error = ensure_credential(Some("GREYWORK_TEST_OFFICE_ABSENT")).unwrap_err();
        assert!(
            error.contains("GREYWORK_TEST_OFFICE_ABSENT"),
            "要指出变量名：{error}"
        );
        assert!(error.contains("设置页"), "要指路设置页：{error}");
    }

    /// 宿主事实查询：只回变量名，不回值；可内嵌 origin 回显**宿主传进来的**那一份。
    #[test]
    fn host_info_partitions_env_names_by_presence() {
        std::env::set_var("GREYWORK_TEST_OFFICE_PRESENT", "1");
        let origins = EMBEDDABLE_FRAME_ORIGINS
            .iter()
            .map(|origin| origin.to_string())
            .collect::<Vec<_>>();
        let info = host_info(
            &origins,
            HostInfoArgs {
                env_names: vec![
                    "GREYWORK_TEST_OFFICE_PRESENT".into(),
                    "GREYWORK_TEST_OFFICE_ABSENT2".into(),
                    "  ".into(),
                    "GREYWORK_TEST_OFFICE_PRESENT".into(),
                ],
            },
        );
        assert_eq!(
            info.env_present,
            vec!["GREYWORK_TEST_OFFICE_PRESENT".to_string()]
        );
        assert_eq!(
            info.env_missing,
            vec!["GREYWORK_TEST_OFFICE_ABSENT2".to_string()]
        );
        assert_eq!(info.embeddable_frame_origins, origins);
        assert!(info
            .embeddable_frame_origins
            .iter()
            .all(|origin| origin.starts_with("https://")));
        // 空名被忽略，不会进任何一侧。
        assert!(!info.env_present.iter().any(|name| name.is_empty()));
        assert!(!info.env_missing.iter().any(|name| name.is_empty()));
    }

    /// 可内嵌 origin 的归一化：小写、剥尾斜杠、去重、丢弃非法项。
    ///
    /// 这几条直接决定渲染端「拿 `new URL(url).origin` 比对」会不会误判 —— 少任何一条都会
    /// 表现为「明明配了却判成不可内嵌」，所以逐条钉住。
    #[test]
    fn host_info_normalizes_embeddable_origins() {
        let info = host_info(
            &[
                "https://Docs.Example.com/".into(),
                "https://docs.example.com".into(), // 与上一条归一化后相同 → 去重
                "https://evil.example.com; script-src *".into(), // 能改写策略 → 丢弃
                "not-an-origin".into(),
                "http://127.0.0.1:8080".into(),
            ],
            HostInfoArgs::default(),
        );
        assert_eq!(
            info.embeddable_frame_origins,
            vec![
                "https://docs.example.com".to_string(),
                "http://127.0.0.1:8080".to_string()
            ]
        );
    }

    /// 服务端态：回的是宿主自己的配置，而不是桌面那份静态常量。
    #[test]
    fn host_info_reports_the_callers_origins_not_the_desktop_default() {
        let info = host_info(
            &["https://self-hosted.example.com".to_string()],
            HostInfoArgs::default(),
        );
        assert_eq!(
            info.embeddable_frame_origins,
            vec!["https://self-hosted.example.com".to_string()]
        );
        assert!(
            !info
                .embeddable_frame_origins
                .contains(&"https://www.kdocs.cn".to_string()),
            "不该混进桌面常量"
        );
    }

    /// 端到端：真起一个本地 HTTP 服务收 multipart，验证「读文件 → 编码文件名 →
    /// 上传（含 `{{ENV}}` 凭证头）→ 取回指针里的地址」整条链路。不需要真厂商凭据。
    #[tokio::test]
    async fn open_preview_uploads_and_returns_view_url() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // 凭证头模板里的占位符由宿主从环境变量解析 —— 这一路是本测试要证明的边界之一。
        // 变量名独此一处，不会与其它用例串味。
        std::env::set_var("GREYWORK_TEST_OFFICE_TOKEN", "test-token-not-a-secret");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let seen = std::sync::Arc::new(parking_lot::Mutex::new(String::new()));
        let seen_writer = std::sync::Arc::clone(&seen);
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buffer = vec![0u8; 8192];
                let read = stream.read(&mut buffer).await.unwrap_or(0);
                *seen_writer.lock() = String::from_utf8_lossy(&buffer[..read]).to_string();
                let body = r#"{"data":{"url":"https://docs.example.com/d/42"}}"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
                let _ = stream.shutdown().await;
            }
        });

        // 授权根 = 临时目录（`WorkspaceFsAccess::new` 会把默认根写进授权集合）。
        let root = std::env::temp_dir().join(format!("gw-office-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("mkdir");
        let file = root.join("季度 报告.docx");
        std::fs::write(&file, b"PK-fake-docx").expect("write");

        let access = WorkspaceFsAccess::new(&root, root.join("ledger.json")).expect("access");
        let mut recipe = recipe();
        recipe.url = format!("http://{addr}/upload?name={{filename}}");
        let result = open_preview(
            &access,
            PreviewOpenArgs {
                path: file.to_string_lossy().to_string(),
                recipe,
                credential_env: None,
                headers: Some(HashMap::from([("X-Org".to_string(), "acme".to_string())])),
            },
        )
        .await
        .expect("upload ok");

        assert_eq!(result.url, "https://docs.example.com/d/42");
        assert_eq!(result.filename, "季度 报告.docx");

        let request = seen.lock().clone();
        assert!(
            request.starts_with("POST /upload?name="),
            "请求行：{request}"
        );
        assert!(
            request.contains("%E5%AD%A3%E5%BA%A6"),
            "文件名要 URL 编码后进查询串：{request}"
        );
        assert!(request.contains("PK-fake-docx"), "文件字节要真的在包体里");

        // 请求头名在 h1 编码时一律小写，故头相关的断言走小写副本
        // （URI 里的百分号编码是大写十六进制，不能被折叠）。
        let headers = request.to_lowercase();
        assert!(
            headers.contains("multipart/form-data"),
            "走 multipart：{request}"
        );
        assert!(
            headers.contains("name=\"file\""),
            "缺省字段名为 file：{request}"
        );
        assert!(
            headers.contains("x-org: acme"),
            "附加请求头要发出去：{request}"
        );
        assert!(
            headers.contains("authorization: bearer test-token-not-a-secret"),
            "凭证头模板里的 {{ENV}} 要由宿主解析后发出：{request}"
        );
        assert!(
            !request.contains("{{GREYWORK_TEST_OFFICE_TOKEN}}"),
            "占位符不得以原文形式出现在请求里：{request}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 路径不在授权根内 → 在发起任何网络请求之前就被挡下。
    #[tokio::test]
    async fn open_preview_refuses_unauthorized_path() {
        let root = std::env::temp_dir().join(format!("gw-office-deny-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("mkdir");
        let outside = std::env::temp_dir().join("gw-office-outside.docx");
        std::fs::write(&outside, b"x").expect("write");

        let access = WorkspaceFsAccess::new(&root, root.join("ledger.json")).expect("access");
        let error = open_preview(
            &access,
            PreviewOpenArgs {
                path: outside.to_string_lossy().to_string(),
                recipe: recipe(),
                credential_env: None,
                headers: None,
            },
        )
        .await
        .expect_err("未授权路径必须被拒");
        assert!(error.contains("未获用户授权"), "实际错误：{error}");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&outside);
    }
}
