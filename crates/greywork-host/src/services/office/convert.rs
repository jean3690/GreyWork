//! 本地 LibreOffice headless 转换：把 Office 文档转成 PDF，交给 `PdfViewer` 做「高保真」呈现。
//!
//! **为什么是「本地转换」而不是「云端委托」**：云端委托（见 [`super`]）要求联网 + 文件外发，
//! 而自研解析器（`docx-parse` / `pptx-parse`）在页眉页脚 / 分栏 / 分页符 / 脚注 / 浮动对象
//! 上有已知缺口。LibreOffice 补的正是这条「不外发、但保真」的中间地带 —— 转成 PDF 后由既有
//! 查看器渲染，属于既定分层里的 **B 驱动层**（按需调用外部工具），不是内嵌编辑器。
//!
//! 设计约束：
//! - **授权先于一切**：输入路径经 [`WorkspaceFsAccess::resolve_existing`] 校验，未授权的路径
//!   在起进程之前就被拒 —— 转换会读用户磁盘上的任意字节并交给外部程序，这道门不能后置。
//! - **每次调用一个独立 profile**：soffice 是「一个 profile 一个实例」，共用一个 profile 会
//!   让并发转换互相抢锁。用 `-env:UserInstallation=file://<scratch>` 指向一次性目录，
//!   并行安全、无需全局互斥。
//! - **失败一律不静默**：这里返回 `Err`（含截断的 stdout/stderr 诊断），由渲染端决定回落
//!   原生 viewer 并把原因显示出来。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::process_guard;
use crate::workspace_fs::WorkspaceFsAccess;

/// 转换超时。首次运行要建字体缓存，给足；正常文档约 1–3s。
const CONVERT_TIMEOUT: Duration = Duration::from_secs(120);
/// 输入上限：与 `fs_read_binary` 的 20MB 契约一致（原生 viewer 也读不了更大的）。
const MAX_INPUT_BYTES: u64 = 20 * 1024 * 1024;
/// 产物上限。转换产物走 `Bin` 返回，**不**经 `fs_read_binary` 的 20MB 读上限，故另设一档；
/// 超限是报错而非截断（截断的 PDF 打不开，报错至少说得清）。
const MAX_OUTPUT_BYTES: u64 = 128 * 1024 * 1024;
/// 诊断文本（stdout/stderr）截断长度（按字符，避免切坏中文）。
const DIAG_CHARS: usize = 400;
/// 单股输出的读取上限（soffice 输出很小，够用即可）。
const STREAM_CAP: usize = 64 * 1024;

/// 进程内自增序号：配合时间戳与 pid 保证 scratch 目录唯一。
static SCRATCH_SEQ: AtomicU64 = AtomicU64::new(0);

/// soffice 的来源，仅用于诊断展示。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SofficeSource {
    /// 来自显式配置（`GREYWORK_SOFFICE_PATH`）。
    Config,
    /// 在 PATH 上探测到。
    Path,
    /// macOS 应用包内的固定位置。
    Bundle,
}

/// `office_convert_to_pdf` 入参。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertArgs {
    /// 工作区内文件的路径（由 [`WorkspaceFsAccess`] 解析并校验授权根）。
    pub path: String,
}

/// `office_convert_info` 结果：渲染端据此决定是否默认走「高保真(PDF)」。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertInfo {
    /// 宿主是否具备可用的 soffice。
    pub available: bool,
    /// 解析到的 soffice 路径（诊断用；不回渲染端做任何决策）。
    pub path: Option<String>,
    /// 来源。`path` 为 `None` 但 `source` 为 `Some(Config)` 表示「配了但不可用」。
    pub source: Option<SofficeSource>,
}

/// 启动期解析一次的 soffice 句柄。纯数据，无 I/O。
#[derive(Debug, Clone)]
pub struct SofficeTool {
    path: Option<PathBuf>,
    source: Option<SofficeSource>,
}

impl SofficeTool {
    /// 解析顺序：显式配置 → PATH 探测 → macOS 应用包。
    ///
    /// 显式配置**优先且权威**：配了却不可用（路径不存在 / 不可执行）时**不回落到 PATH**，
    /// 而是记为「配置了但不可用」（`path=None, source=Some(Config)`）—— 静默回落到另一个
    /// soffice 会让「配置写错了」这件事永远查不出来。
    pub fn discover(explicit: Option<&Path>) -> Self {
        if let Some(raw) = explicit.filter(|path| !path.as_os_str().is_empty()) {
            return match probe_path(raw) {
                Some(found) => Self {
                    path: Some(found),
                    source: Some(SofficeSource::Config),
                },
                None => Self {
                    path: None,
                    source: Some(SofficeSource::Config),
                },
            };
        }
        if let Some(found) = process_guard::probe_program("soffice", None) {
            return Self {
                path: Some(found),
                source: Some(SofficeSource::Path),
            };
        }
        match probe_macos_bundle() {
            Some(found) => Self {
                path: Some(found),
                source: Some(SofficeSource::Bundle),
            },
            None => Self {
                path: None,
                source: None,
            },
        }
    }

    /// 测试用：不依赖宿主 PATH。
    pub fn for_test(path: Option<PathBuf>) -> Self {
        let source = path.as_ref().map(|_| SofficeSource::Config);
        Self { path, source }
    }

    pub fn info(&self) -> ConvertInfo {
        ConvertInfo {
            available: self.path.is_some(),
            path: self
                .path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            source: self.source,
        }
    }

    pub fn program(&self) -> Option<&Path> {
        self.path.as_deref()
    }
}

/// 只读可用性报告。
pub fn convert_info(tool: &SofficeTool) -> ConvertInfo {
    tool.info()
}

/// 把一份**已授权**的 Office 文件转成 PDF，返回字节。
pub async fn convert_to_pdf(
    data_dir: &Path,
    workspace: &WorkspaceFsAccess,
    tool: &SofficeTool,
    args: ConvertArgs,
) -> Result<Vec<u8>, String> {
    let program = tool
        .program()
        .ok_or_else(|| missing_soffice_message(tool))?;

    // 授权先于一切：未授权路径在起进程之前就拒。
    let input = workspace.resolve_existing(&args.path)?;
    let metadata = std::fs::metadata(&input).map_err(|error| format!("读取元数据失败: {error}"))?;
    if metadata.len() > MAX_INPUT_BYTES {
        return Err("文件超过 20MB 上限，无法用 LibreOffice 转换".into());
    }

    let scratch = scratch_dir(data_dir)?;
    let profile = scratch.join("profile");
    let out_dir = scratch.join("out");

    // 产物读取必须在删 scratch 之前完成，所以整段（建目录 → 转换 → 定位 → 读）收在一个
    // 闭包里，外层无论成败统一清理。
    let outcome = async {
        std::fs::create_dir_all(&profile).map_err(|error| format!("创建临时目录失败: {error}"))?;
        std::fs::create_dir_all(&out_dir).map_err(|error| format!("创建临时目录失败: {error}"))?;

        let (stdout, stderr) = spawn_convert(program, &profile, &out_dir, &input).await?;
        let output = find_output(&out_dir, &input)
            .ok_or_else(|| format!("LibreOffice 未产出 PDF：{}", diagnostics(&stdout, &stderr)))?;
        let output_meta =
            std::fs::metadata(&output).map_err(|error| format!("读取转换产物失败: {error}"))?;
        if output_meta.len() > MAX_OUTPUT_BYTES {
            return Err("转换产物超过 128MB 上限".into());
        }
        std::fs::read(&output).map_err(|error| format!("读取转换产物失败: {error}"))
    }
    .await;

    let _ = std::fs::remove_dir_all(&scratch);
    outcome
}

/* ===== 纯逻辑（便于单测，不碰文件系统与进程） ===== */

/// soffice 的 argv（程序名不在此列，它是 `Command::new` 的参数）。
///
/// `--headless` 系列让它不进 UI；`--nolockcheck` 抑制 profile 锁告警（配合一次性 profile）；
/// `-env:UserInstallation` 指向一次性 profile 目录，是并发安全的关键。
pub fn build_convert_args(profile_dir: &Path, out_dir: &Path, input: &Path) -> Vec<OsString> {
    vec![
        OsString::from("--headless"),
        OsString::from("--norestore"),
        OsString::from("--invisible"),
        OsString::from("--nolockcheck"),
        OsString::from("--nodefault"),
        OsString::from("--nologo"),
        OsString::from(format!("-env:UserInstallation={}", file_uri(profile_dir))),
        OsString::from("--convert-to"),
        OsString::from("pdf"),
        OsString::from("--outdir"),
        out_dir.as_os_str().to_os_string(),
        input.as_os_str().to_os_string(),
    ]
}

/// soffice 的产物路径约定：`out_dir/<输入主名>.pdf`。
pub fn expected_output_path(out_dir: &Path, input: &Path) -> PathBuf {
    let mut name = input.file_stem().map(OsString::from).unwrap_or_default();
    name.push(".pdf");
    out_dir.join(name)
}

/// `-env:UserInstallation=` 需要的 `file://` URI。
///
/// unix → `file:///abs/path`；Windows → `file:///C:/...`（反斜杠归一为正斜杠）。
pub fn file_uri(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let absolute = if normalized.starts_with('/') {
        normalized
    } else {
        format!("/{normalized}")
    };
    format!("file://{}", encode_uri_path(&absolute))
}

/// 按 URL 路径段规则编码：保留 unreserved 字符与 `/`，其余一律 `%XX`。
///
/// 空格与中文必须编码 —— 不编码时 soffice 会把 URI 解析歪，表现是「profile 目录建不出来」
/// 或直接静默用默认 profile（并发时互相抢锁）。
fn encode_uri_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.as_bytes() {
        let character = *byte as char;
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '~' | '/') {
            out.push(character);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/* ===== 进程与文件系统（唯一做 I/O 的地方） ===== */

/// 建一次性 scratch 目录（`<app_data>/office/convert/<时间戳>-<pid>-<序号>`）。
fn scratch_dir(data_dir: &Path) -> Result<PathBuf, String> {
    let seq = SCRATCH_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let dir = data_dir
        .join("office")
        .join("convert")
        .join(format!("{nanos}-{}-{seq}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建临时目录失败: {error}"))?;
    Ok(dir)
}

/// 起 soffice 跑一次转换，回收合并前的 stdout / stderr。
async fn spawn_convert(
    program: &Path,
    profile: &Path,
    out_dir: &Path,
    input: &Path,
) -> Result<(String, String), String> {
    let mut builder = tokio::process::Command::new(program);
    builder.args(build_convert_args(profile, out_dir, input));
    builder
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // GUI 启动时继承的 PATH 可能残缺，显式注入登录 shell 解析出的 PATH。
    if let Some((key, value)) = process_guard::path_env() {
        builder.env(key, value);
    }
    process_guard::isolate_process_group(&mut builder);
    process_guard::hide_console_tokio(&mut builder);

    let mut child = builder
        .spawn()
        .map_err(|error| format!("启动 LibreOffice 失败: {error}"))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let collected = tokio::time::timeout(CONVERT_TIMEOUT, async {
        let (out, err) = tokio::join!(read_capped(stdout), read_capped(stderr));
        (out, err)
    })
    .await;

    let (stdout_bytes, stderr_bytes) = match collected {
        Ok(pair) => pair,
        Err(_) => {
            // 超时：先收整棵进程树（soffice 会 fork 出子进程），再回收直接子进程。
            if let Some(pid) = pid {
                process_guard::kill_process_tree(pid);
            }
            let _ = child.kill().await;
            return Err(format!(
                "LibreOffice 转换超时（{}s）",
                CONVERT_TIMEOUT.as_secs()
            ));
        }
    };
    // 退出码不单独判：成功与否以「产物是否存在」为准（soffice 偶有非零退出却仍写出文件）。
    let _ = child
        .wait()
        .await
        .map_err(|error| format!("回收 LibreOffice 进程失败: {error}"))?;

    Ok((
        String::from_utf8_lossy(&stdout_bytes).into_owned(),
        String::from_utf8_lossy(&stderr_bytes).into_owned(),
    ))
}

/// 并发读干一股输出，截到 [`STREAM_CAP`]（到顶后继续读但丢弃，避免管道写满阻塞子进程）。
async fn read_capped<R: AsyncRead + Unpin>(reader: Option<R>) -> Vec<u8> {
    let Some(mut reader) = reader else {
        return Vec::new();
    };
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(read) => {
                if buffer.len() < STREAM_CAP {
                    let take = read.min(STREAM_CAP - buffer.len());
                    buffer.extend_from_slice(&chunk[..take]);
                }
            }
            Err(_) => break,
        }
    }
    buffer
}

/// 定位产物：先按约定名，退化到扫描 `out/` 里第一个 `.pdf`。
fn find_output(out_dir: &Path, input: &Path) -> Option<PathBuf> {
    let expected = expected_output_path(out_dir, input);
    if expected.is_file() {
        return Some(expected);
    }
    let entries = std::fs::read_dir(out_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_pdf = path
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("pdf"))
            .unwrap_or(false);
        if is_pdf && path.is_file() {
            return Some(path);
        }
    }
    None
}

/// 拼一份可读的诊断（stdout + stderr，截断）。
fn diagnostics(stdout: &str, stderr: &str) -> String {
    let combined = format!("{stdout}\n{stderr}");
    let trimmed = combined.trim();
    if trimmed.is_empty() {
        return "（无输出）".into();
    }
    crate::llm::truncate(trimmed, DIAG_CHARS)
}

/// 显式路径解析：绝对路径与裸名都走 `probe_program`（后者按 PATH 解析）。
fn probe_path(path: &Path) -> Option<PathBuf> {
    let raw = path.to_string_lossy();
    process_guard::probe_program(&raw, None)
}

/// macOS 上 LibreOffice 通常不在 PATH，而在应用包内。
fn probe_macos_bundle() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mut candidates = vec![PathBuf::from(
            "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        )];
        if let Some(home) = std::env::var_os("HOME") {
            candidates.push(
                PathBuf::from(home).join("Applications/LibreOffice.app/Contents/MacOS/soffice"),
            );
        }
        for candidate in candidates {
            let raw = candidate.to_string_lossy();
            if let Some(found) = process_guard::probe_program(&raw, None) {
                return Some(found);
            }
        }
        None
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// 找不到 soffice 时的错误文案：区分「配了但不可用」与「压根没装」。
fn missing_soffice_message(tool: &SofficeTool) -> String {
    match tool.source {
        Some(SofficeSource::Config) => {
            "GREYWORK_SOFFICE_PATH 指向的 soffice 不可用：请确认该路径存在且可执行".to_string()
        }
        _ => "未找到 LibreOffice（soffice）。Docker 镜像已内置；本机请安装 LibreOffice，\
              或设置 GREYWORK_SOFFICE_PATH 指向 soffice 可执行文件"
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间早于 UNIX 纪元")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("gw-office-convert-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    #[test]
    fn convert_args_carry_the_expected_flags() {
        let args = build_convert_args(
            Path::new("/tmp/p"),
            Path::new("/tmp/o"),
            Path::new("/w/a.docx"),
        );
        let rendered: Vec<String> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        for flag in [
            "--headless",
            "--norestore",
            "--invisible",
            "--nolockcheck",
            "--nodefault",
            "--nologo",
            "--convert-to",
            "pdf",
            "--outdir",
        ] {
            assert!(
                rendered.iter().any(|a| a == flag),
                "缺少 {flag}: {rendered:?}"
            );
        }
        assert!(
            rendered
                .iter()
                .any(|a| a.starts_with("-env:UserInstallation=file://")),
            "缺少 profile 隔离参数: {rendered:?}"
        );
        assert_eq!(rendered.last().unwrap(), "/w/a.docx", "输入文件在最后");
        // 无 shell 元字符：即使配置被注入也不能被解释成管道 / 重定向。
        let joined = rendered.join(" ");
        assert!(
            !joined
                .chars()
                .any(|c| process_guard::SHELL_META_CHARS.contains(&c)),
            "argv 不应含 shell 元字符: {joined}"
        );
    }

    #[test]
    fn expected_output_path_uses_input_stem() {
        let out = Path::new("/tmp/out");
        assert_eq!(
            expected_output_path(out, Path::new("/w/季度 报告.docx")),
            PathBuf::from("/tmp/out/季度 报告.pdf")
        );
        assert_eq!(
            expected_output_path(out, Path::new("/w/slides.PPT")),
            PathBuf::from("/tmp/out/slides.pdf")
        );
    }

    #[test]
    fn file_uri_is_absolute_and_encoded() {
        let uri = file_uri(Path::new("/tmp/用户 目录/p"));
        assert!(uri.starts_with("file:///"), "{uri}");
        assert!(uri.contains("%20"), "空格要编码: {uri}");
        assert!(!uri.contains(' '), "不应残留裸空格: {uri}");
        assert!(uri.contains('/'), "斜杠保留: {uri}");
    }

    #[test]
    fn encode_uri_path_keeps_unreserved() {
        assert_eq!(encode_uri_path("/a/b-c_d.e~f"), "/a/b-c_d.e~f");
        assert_eq!(encode_uri_path("a b#c"), "a%20b%23c");
    }

    #[test]
    fn discover_prefers_explicit_and_reports_unusable_config() {
        // 显式给一个真实存在的可执行文件（当前测试可执行体自身）→ Config。
        let me = std::env::current_exe().expect("current_exe");
        let tool = SofficeTool::discover(Some(&me));
        assert_eq!(tool.info().source, Some(SofficeSource::Config));
        assert!(tool.info().available);
        assert_eq!(tool.program(), Some(me.as_path()));

        // 显式给了但不可用 → 记为 Config 但 unavailable（不回落到 PATH）。
        let tool = SofficeTool::discover(Some(Path::new("/nonexistent/soffice-xyz")));
        assert_eq!(tool.info().source, Some(SofficeSource::Config));
        assert!(!tool.info().available);
        assert!(tool.program().is_none());
        assert!(
            missing_soffice_message(&tool).contains("GREYWORK_SOFFICE_PATH"),
            "配了但不可用要指路到配置项"
        );
    }

    #[test]
    fn for_test_reports_presence() {
        assert!(!SofficeTool::for_test(None).info().available);
        let tool = SofficeTool::for_test(Some(PathBuf::from("/x/soffice")));
        assert!(tool.info().available);
        assert_eq!(tool.program(), Some(Path::new("/x/soffice")));
    }

    /// 未授权路径：在起任何进程之前就被拒。
    #[tokio::test]
    async fn convert_refuses_unauthorized_path_before_spawning() {
        let root = temp_dir("deny-root");
        let outside = std::env::temp_dir().join(format!("gw-outside-{}.docx", std::process::id()));
        std::fs::write(&outside, b"x").expect("写外部文件");
        let access = WorkspaceFsAccess::new(&root, root.join("ledger.json")).expect("授权面");
        let data_dir = temp_dir("deny-data");
        // program 指向当前测试可执行体：即使真的起进程也不会成功转换 —— 但这里断言的是
        // 「授权在 spawn 之前就拒」，所以拿不到「未获用户授权」即算失败。
        let tool = SofficeTool::for_test(Some(std::env::current_exe().expect("current_exe")));

        let error = convert_to_pdf(
            &data_dir,
            &access,
            &tool,
            ConvertArgs {
                path: outside.to_string_lossy().into_owned(),
            },
        )
        .await
        .expect_err("未授权路径必须被拒");
        assert!(error.contains("未获用户授权"), "实际错误：{error}");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&data_dir);
        let _ = std::fs::remove_file(&outside);
    }

    /// 未装 soffice → 明确报错（不 panic、不静默）。
    #[tokio::test]
    async fn convert_reports_missing_soffice() {
        let root = temp_dir("missing-root");
        let file = root.join("a.docx");
        std::fs::write(&file, b"PK").expect("写文件");
        let access = WorkspaceFsAccess::new(&root, root.join("ledger.json")).expect("授权面");
        let data_dir = temp_dir("missing-data");
        let error = convert_to_pdf(
            &data_dir,
            &access,
            &SofficeTool::for_test(None),
            ConvertArgs {
                path: file.to_string_lossy().into_owned(),
            },
        )
        .await
        .expect_err("无 soffice 必须报错");
        assert!(error.contains("soffice"), "实际错误：{error}");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// 端到端：真起 soffice 把一份内联 RTF 转成 PDF。未安装 soffice 时早返回（跳过）。
    ///
    /// 用 RTF 而不是 docx：RTF 是纯文本 fixture，不需要 zip 依赖，soffice 原生支持。
    #[tokio::test]
    async fn converts_rtf_to_pdf_when_soffice_present() {
        if process_guard::probe_program("soffice", None).is_none() {
            return; // 跳过：本机未安装 LibreOffice
        }
        let root = temp_dir("e2e-root");
        let file = root.join("sample.rtf");
        std::fs::write(
            &file,
            r"{\rtf1\ansi\deff0 {\fonttbl {\f0 Times New Roman;}}\f0\fs24 Hello LibreOffice.\par}",
        )
        .expect("写 RTF");
        let access = WorkspaceFsAccess::new(&root, root.join("ledger.json")).expect("授权面");
        let data_dir = temp_dir("e2e-data");
        let tool = SofficeTool::discover(None);

        let bytes = convert_to_pdf(
            &data_dir,
            &access,
            &tool,
            ConvertArgs {
                path: file.to_string_lossy().into_owned(),
            },
        )
        .await
        .expect("转换成功");
        assert!(bytes.starts_with(b"%PDF-"), "产物应是 PDF");
        // scratch 目录应被清理干净。
        let convert_root = data_dir.join("office").join("convert");
        let leftover = std::fs::read_dir(&convert_root)
            .map(|entries| entries.count())
            .unwrap_or(0);
        assert_eq!(leftover, 0, "scratch 目录应清空");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&data_dir);
    }
}
