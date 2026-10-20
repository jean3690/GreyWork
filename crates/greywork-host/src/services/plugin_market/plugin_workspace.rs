//! 前端 workspace.read 能力的宿主侧只读入口。
//!
//! 与 [`super::plugin_fs`]（插件私有沙箱）相反，这里读的是**用户已授权的工作区**：
//!
//! - **不新建白名单**：路径一律经 [`WorkspaceFsAccess::resolve_existing`] 解析 —— 它先
//!   `canonicalize`（符号链接按真实目标判定），再要求落在授权根 / 单独授权的文件内；
//! - **只读**：没有 write / remove 分支，插件拿不到任何落盘入口；
//! - **内容预览**：单次最多 256 KiB，二进制文件直接拒绝（插件要摘要的是文本）；
//! - **列根**：`roots` 只回授权根，不暴露授权集之外的任何目录；
//! - **错误归一**：授权失败与文件不存在返回同一句错误，不给插件当磁盘探针用。

use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::validate::validate_dir_key;
use crate::infra::workspace_fs::WorkspaceFsAccess;

/// 单次读取上限（256 KiB）：插件只做预览 / 摘要，不该把大文件整块拉进 worker。
pub const MAX_PLUGIN_WORKSPACE_READ_BYTES: u64 = 256 * 1024;
/// 路径长度上限（与 fs.scoped 同一口径）。
const MAX_PATH_CHARS: usize = 4096;
/// 二进制嗅探窗口。
const BINARY_SNIFF_BYTES: usize = 8192;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginWorkspaceOp {
    Roots,
    Read,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginWorkspaceRequest {
    pub plugin_id: String,
    pub op: PluginWorkspaceOp,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginWorkspaceRoot {
    /// 绝对路径（授权根）。
    pub path: String,
    /// 目录名（前端展示用；根目录回退为完整路径）。
    pub name: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginWorkspaceResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roots: Option<Vec<PluginWorkspaceRoot>>,
    /// 规范化后的绝对路径（`read` 有值）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    /// 文件**总**字节数（不是本次返回的字节数；配合 `truncated` 判断）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exists: Option<bool>,
}

/// `workspace.read` 的宿主侧实现（`plugin_workspace` 命令）。
pub fn plugin_workspace(
    access: &WorkspaceFsAccess,
    request: PluginWorkspaceRequest,
) -> Result<PluginWorkspaceResponse, String> {
    // 只做形态校验：workspace.read 不需要按插件隔离目录，id 仅用于挡住畸形输入。
    validate_dir_key(&request.plugin_id, "plugin id")?;
    match request.op {
        PluginWorkspaceOp::Roots => Ok(PluginWorkspaceResponse {
            roots: Some(workspace_roots(access)),
            ..Default::default()
        }),
        PluginWorkspaceOp::Read => {
            let raw = request.path.as_deref().unwrap_or_default().trim();
            if raw.is_empty() {
                return Err("workspace.read requires a non-empty path".to_string());
            }
            if raw.chars().count() > MAX_PATH_CHARS {
                return Err(format!(
                    "workspace.read path exceeds {MAX_PATH_CHARS} characters"
                ));
            }
            workspace_read(access, raw)
        }
    }
}

fn workspace_roots(access: &WorkspaceFsAccess) -> Vec<PluginWorkspaceRoot> {
    let mut roots: Vec<PluginWorkspaceRoot> = access
        .authorized_roots()
        .into_iter()
        .map(|path| {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.display().to_string());
            PluginWorkspaceRoot {
                path: path.display().to_string(),
                name,
            }
        })
        .collect();
    // 授权集来自 HashSet：给前端一个确定的顺序。
    roots.sort_by(|left, right| left.path.cmp(&right.path));
    roots
}

fn workspace_read(
    access: &WorkspaceFsAccess,
    raw: &str,
) -> Result<PluginWorkspaceResponse, String> {
    // 授权失败与不存在用同一句错误：不把「根外某个路径存不存在」变成探针。
    let path = access
        .resolve_existing(raw)
        .map_err(|_| "workspace.read path is not an authorized existing path".to_string())?;
    let metadata = std::fs::metadata(&path).map_err(|error| format!("读取元数据失败: {error}"))?;
    if !metadata.is_file() {
        return Err("workspace.read only reads regular files".to_string());
    }

    let size = metadata.len();
    let truncated = size > MAX_PLUGIN_WORKSPACE_READ_BYTES;
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .and_then(|file| {
            file.take(MAX_PLUGIN_WORKSPACE_READ_BYTES)
                .read_to_end(&mut bytes)
        })
        .map_err(|error| format!("读取文件失败: {error}"))?;

    if crate::text::looks_binary(&bytes[..bytes.len().min(BINARY_SNIFF_BYTES)]) {
        return Err("workspace.read only returns text files".to_string());
    }
    if truncated {
        // 截断点可能落在多字节字符中间：最多退 3 个字节，让 UTF-8 尾巴合法。
        for _ in 0..3 {
            if std::str::from_utf8(&bytes).is_ok() {
                break;
            }
            bytes.pop();
        }
    }

    Ok(PluginWorkspaceResponse {
        path: Some(display_path(&path)),
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned()),
        data: Some(crate::text::decode_text_bytes(&bytes)),
        bytes: Some(size),
        truncated: Some(truncated),
        exists: Some(true),
        roots: None,
    })
}

/// 去掉 Windows 的 `\\?\` 前缀，前端拿到的是可读路径。
fn display_path(path: &Path) -> String {
    crate::path_safety::strip_verbatim_prefix(&path.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn temp_root(tag: &str) -> PathBuf {
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "greywork-plugin-workspace-{tag}-{}-{seq}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn access(tag: &str) -> (WorkspaceFsAccess, PathBuf) {
        let root = temp_root(tag);
        let access = WorkspaceFsAccess::new(&root, root.join("access.json")).expect("构造授权面");
        (access, root)
    }

    fn request(op: PluginWorkspaceOp, path: Option<&str>) -> PluginWorkspaceRequest {
        PluginWorkspaceRequest {
            plugin_id: "demo.workspace".into(),
            op,
            path: path.map(str::to_string),
        }
    }

    #[test]
    fn roots_lists_the_authorized_root() {
        let (access, root) = access("roots");
        let response =
            plugin_workspace(&access, request(PluginWorkspaceOp::Roots, None)).expect("列根");
        let roots = response.roots.expect("应返回 roots");
        assert_eq!(roots.len(), 1);
        assert_eq!(
            Path::new(&roots[0].path),
            root.canonicalize().expect("规范化根目录")
        );
    }

    #[test]
    fn read_returns_text_and_metadata() {
        let (access, root) = access("read");
        let file = root.join("README.md");
        std::fs::write(&file, "# 标题\n正文").expect("写样本");
        let response = plugin_workspace(&access, request(PluginWorkspaceOp::Read, file.to_str()))
            .expect("读文件");

        assert_eq!(response.data.as_deref(), Some("# 标题\n正文"));
        assert_eq!(response.name.as_deref(), Some("README.md"));
        assert_eq!(response.bytes, Some(file.metadata().expect("元数据").len()));
        assert_eq!(response.truncated, Some(false));
    }

    #[test]
    fn read_rejects_paths_outside_the_authorized_root() {
        let (access, _root) = access("outside");
        let outside = temp_root("outside-file");
        let file = outside.join("secret.txt");
        std::fs::write(&file, "nope").expect("写样本");

        let error = plugin_workspace(&access, request(PluginWorkspaceOp::Read, file.to_str()))
            .expect_err("根外路径应被拒");
        assert!(error.contains("not an authorized"), "实际: {error}");
    }

    #[test]
    fn read_rejects_binary_files_and_directories() {
        let (access, root) = access("binary");
        let binary = root.join("blob.bin");
        std::fs::write(&binary, [0u8, 1, 2, 3]).expect("写样本");
        let error = plugin_workspace(&access, request(PluginWorkspaceOp::Read, binary.to_str()))
            .expect_err("二进制应被拒");
        assert!(error.contains("text"), "实际: {error}");

        let error = plugin_workspace(&access, request(PluginWorkspaceOp::Read, root.to_str()))
            .expect_err("目录应被拒");
        assert!(error.contains("regular files"), "实际: {error}");
    }

    #[test]
    fn read_truncates_large_files_at_a_char_boundary() {
        let (access, root) = access("truncate");
        let file = root.join("big.txt");
        // 3 字节一个汉字：必然在 MAX 处切断一个多字节字符。
        let body = "界".repeat(MAX_PLUGIN_WORKSPACE_READ_BYTES as usize / 3 + 10);
        std::fs::write(&file, &body).expect("写样本");

        let response = plugin_workspace(&access, request(PluginWorkspaceOp::Read, file.to_str()))
            .expect("读大文件");
        assert_eq!(response.truncated, Some(true));
        assert_eq!(response.bytes, Some(body.len() as u64), "bytes 是文件总长");
        let data = response.data.expect("应有数据");
        assert!(data.len() <= MAX_PLUGIN_WORKSPACE_READ_BYTES as usize);
        assert!(data.chars().all(|ch| ch == '界'), "截断不应产生乱码");
    }

    #[test]
    fn rejects_malformed_plugin_id() {
        let (access, _root) = access("id");
        let mut req = request(PluginWorkspaceOp::Roots, None);
        req.plugin_id = "../evil".into();
        assert!(plugin_workspace(&access, req).is_err());
    }
}
