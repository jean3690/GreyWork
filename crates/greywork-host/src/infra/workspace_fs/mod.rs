use base64::Engine as _;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const MAX_TEXT_BYTES: usize = 10 * 1024 * 1024;
const MAX_BINARY_BYTES: usize = 20 * 1024 * 1024;
/// 媒体（视频 / 3D 模型 / GIS 栅格）专用硬顶。
///
/// 真实视频与带贴图的模型普遍超过 20MB，按预览口径卡死等于这类文件一律打不开。
/// **只由 `fs_read_media` 使用** —— `fs_read_binary` 的 20MB 契约另有 `office.rs` 与
/// 附件通道在依赖，放宽它等于把「谁可以一次分配 128MB」散到所有调用点。
const MAX_MEDIA_BYTES: usize = 128 * 1024 * 1024;
/// 调用方没给额度时的默认值：与 `MAX_BINARY_BYTES` 一致，避免「不写 maxBytes 就默默放宽」。
const DEFAULT_MEDIA_BYTES: usize = MAX_BINARY_BYTES;

#[derive(Debug, Default)]
struct AuthorizedPathSet {
    roots: BTreeSet<PathBuf>,
    files: BTreeSet<PathBuf>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizedPathLedger {
    roots: Vec<PathBuf>,
    files: Vec<PathBuf>,
}

/// 渲染端磁盘 IO 的唯一授权面。
///
/// 授权只由宿主可验证的用户动作产生（系统选择器、OS 拖放）或应用私有数据根产生；
/// 普通 IPC 调用只能消费既有授权，不能自行扩大可读写范围。
pub struct WorkspaceFsAccess {
    ledger_path: PathBuf,
    paths: RwLock<AuthorizedPathSet>,
}

impl WorkspaceFsAccess {
    pub fn new(default_root: &Path, ledger_path: PathBuf) -> Result<Self, String> {
        let default_root = canonical_existing(default_root)?;
        let mut paths = AuthorizedPathSet::default();
        paths.roots.insert(default_root);
        // BOM 容错：账本被编辑器存成「UTF-8 with BOM」时 from_slice 会解析失败，
        // 表现是「授权记录被静默清空」（见 text::read_bytes_without_bom）。
        if let Ok(raw) = crate::text::read_bytes_without_bom(&ledger_path) {
            if let Ok(saved) = serde_json::from_slice::<AuthorizedPathLedger>(&raw) {
                for root in saved.roots {
                    if root.is_dir() {
                        if let Ok(root) = canonical_existing(&root) {
                            paths.roots.insert(root);
                        }
                    }
                }
                for file in saved.files {
                    if file.is_file() {
                        if let Ok(file) = canonical_existing(&file) {
                            paths.files.insert(file);
                        }
                    }
                }
            }
        }
        Ok(Self {
            ledger_path,
            paths: RwLock::new(paths),
        })
    }

    pub fn authorize_selected_path(&self, path: &Path) -> Result<PathBuf, String> {
        let canonical = canonical_existing(path)?;
        let metadata = std::fs::metadata(&canonical)
            .map_err(|error| format!("读取授权路径元数据失败: {error}"))?;
        let mut paths = self.paths.write();
        if metadata.is_dir() {
            paths.roots.insert(canonical.clone());
        } else if metadata.is_file() {
            paths.files.insert(canonical.clone());
        } else {
            return Err("只允许授权普通文件或目录".into());
        }
        self.persist(&paths)?;
        Ok(canonical)
    }

    pub fn authorize_selected_paths<'a>(
        &self,
        selected: impl IntoIterator<Item = &'a PathBuf>,
    ) -> Result<Vec<String>, String> {
        let mut canonical = Vec::new();
        for path in selected {
            let path = canonical_existing(path)?;
            let metadata = std::fs::metadata(&path)
                .map_err(|error| format!("读取授权路径元数据失败: {error}"))?;
            if !metadata.is_file() {
                return Err("文件选择器只允许授权普通文件".into());
            }
            canonical.push(path);
        }
        let mut paths = self.paths.write();
        paths.files.extend(canonical.iter().cloned());
        self.persist(&paths)?;
        Ok(canonical
            .into_iter()
            // 返回渲染端前剥掉 `\\?\`：那是宿主内部形态，露到 UI 里既难看又会让
            // 前端的绝对路径判定失效（见 path_safety::strip_verbatim_prefix）。
            .map(|path| crate::path_safety::strip_verbatim_prefix(&path.to_string_lossy()))
            .collect())
    }

    pub fn authorize_drop_paths<'a>(
        &self,
        dropped: impl IntoIterator<Item = &'a PathBuf>,
    ) -> Result<(), String> {
        let mut canonical = Vec::new();
        for path in dropped {
            let path = canonical_existing(path)?;
            let metadata = std::fs::metadata(&path)
                .map_err(|error| format!("读取拖放路径元数据失败: {error}"))?;
            if metadata.is_file() {
                canonical.push(path);
            }
        }
        if canonical.is_empty() {
            return Ok(());
        }
        let mut paths = self.paths.write();
        paths.files.extend(canonical);
        self.persist(&paths)
    }

    pub fn validate_existing(&self, raw: &str) -> Result<PathBuf, String> {
        self.resolve_existing(raw)
    }

    fn persist(&self, paths: &AuthorizedPathSet) -> Result<(), String> {
        if let Some(parent) = self.ledger_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("创建路径授权目录失败: {error}"))?;
        }
        let ledger = AuthorizedPathLedger {
            roots: paths.roots.iter().cloned().collect(),
            files: paths.files.iter().cloned().collect(),
        };
        let bytes = serde_json::to_vec_pretty(&ledger)
            .map_err(|error| format!("序列化路径授权失败: {error}"))?;
        let temp = self.ledger_path.with_extension("json.tmp");
        std::fs::write(&temp, bytes).map_err(|error| format!("写入路径授权失败: {error}"))?;
        // 短暂重试：Windows 上目标文件可能被编辑器/杀软占用一瞬，rename 会 EBUSY/EPERM。
        // 授权保存失败会让用户刚选的目录下次启动就失效，值得多试两次。
        rename_with_retry(&temp, &self.ledger_path)
            .map_err(|error| format!("提交路径授权失败: {error}"))
    }

    /// 解析已存在的授权路径（`git` / `worktree` / `channel_media` 等都要用：它们必须跑在
    /// 授权根内）。公开是因为调用方分布在共享 crate 与各宿主壳两侧。
    pub fn resolve_existing(&self, raw: &str) -> Result<PathBuf, String> {
        let canonical = canonical_existing(Path::new(raw))?;
        self.require_authorized(&canonical)?;
        Ok(canonical)
    }

    fn resolve_write(&self, raw: &str) -> Result<PathBuf, String> {
        let requested = validate_absolute(Path::new(raw))?;
        if requested.exists() {
            return self.resolve_existing(raw);
        }
        let mut ancestor = requested.as_path();
        while !ancestor.exists() {
            ancestor = ancestor
                .parent()
                .ok_or_else(|| "写入路径没有可访问的父目录".to_string())?;
        }
        let canonical_ancestor = canonical_existing(ancestor)?;
        self.require_authorized_root(&canonical_ancestor)?;
        let suffix = requested
            .strip_prefix(ancestor)
            .map_err(|_| "无法解析写入路径".to_string())?;
        Ok(canonical_ancestor.join(suffix))
    }

    fn require_authorized(&self, path: &Path) -> Result<(), String> {
        let paths = self.paths.read();
        if paths.files.contains(path) || paths.roots.iter().any(|root| path.starts_with(root)) {
            Ok(())
        } else {
            Err(format!("路径未获用户授权: {}", path.display()))
        }
    }

    fn require_authorized_root(&self, path: &Path) -> Result<(), String> {
        let paths = self.paths.read();
        if paths.roots.iter().any(|root| path.starts_with(root)) {
            Ok(())
        } else {
            Err(format!("写入目录未获用户授权: {}", path.display()))
        }
    }

    /// 解析**条目本身**（不跟随符号链接），并要求它的父目录在某个授权根内。
    ///
    /// `resolve_existing` 会 `canonicalize`，也就是把符号链接解析成目标 —— 对「读这个
    /// 文件的内容」是对的，对「删除 / 改名这个条目」是错的：删一条指向根内某文件的软链，
    /// 删掉的是那个目标文件。这里改用 `list_dir` 的同款技巧（`:398`）：规范化**父目录**
    /// 并校验它在授权根内，再把文件名原样接回去，于是拿到的始终是条目自己。
    ///
    /// 顺带把「CRUD 只作用于授权根内」这条语义落在这里：父目录必须在 root 之下，
    /// 于是 `paths.files` 里那些**单独授权**的散文件不会被 CRUD 消费（它们的父目录不是
    /// root，`resolve_write` 也必拒 —— 若允许删除就会出现「能删但不能改名」的割裂）。
    fn resolve_entry(&self, raw: &str) -> Result<PathBuf, String> {
        let requested = validate_absolute(Path::new(raw))?;
        let name = requested
            .file_name()
            .ok_or_else(|| "路径缺少文件名".to_string())?;
        let parent = requested
            .parent()
            .ok_or_else(|| "路径缺少父目录".to_string())?;
        let canonical_parent = canonical_existing(parent)?;
        self.require_authorized_root(&canonical_parent)?;
        Ok(canonical_parent.join(name))
    }

    /// 该路径是否是某个已授权的工作区根。
    ///
    /// `path_safety::is_filesystem_root` 只认 `/`、`C:\`、UNC 这类**文件系统**根，
    /// 认不出用户绑定进来的工作区目录；而 roots 集合是私有的，所以这里补一个只读判据。
    pub fn is_authorized_root(&self, path: &Path) -> bool {
        self.paths
            .read()
            .roots
            .iter()
            .any(|root| crate::path_safety::same_path(root, path))
    }

    /// 已授权根的只读快照（RAG 索引遍历的入口）。
    ///
    /// 返回的是内部路径的克隆 —— 调用方拿到的只是「可以去看哪些目录」，任何读写仍走
    /// `resolve_existing` / `require_authorized` 收口，不存在绕过授权面直接落盘的路径。
    pub fn authorized_roots(&self) -> Vec<PathBuf> {
        self.paths.read().roots.iter().cloned().collect()
    }
}

// 端口 trait 实现：消费方依赖 `core::ports::WorkspaceFs` / `WorkspaceAuthorizer`，
// 由本类型提供具体行为。委托到同名 inherent 方法（inherent 优先，不会递归）。
impl crate::core::ports::WorkspaceFs for WorkspaceFsAccess {
    fn resolve_existing(&self, raw: &str) -> Result<PathBuf, String> {
        WorkspaceFsAccess::resolve_existing(self, raw)
    }

    fn validate_existing(&self, raw: &str) -> Result<PathBuf, String> {
        WorkspaceFsAccess::validate_existing(self, raw)
    }

    fn is_authorized_root(&self, path: &Path) -> bool {
        WorkspaceFsAccess::is_authorized_root(self, path)
    }

    fn authorized_roots(&self) -> Vec<PathBuf> {
        WorkspaceFsAccess::authorized_roots(self)
    }
}

impl crate::core::ports::WorkspaceAuthorizer for WorkspaceFsAccess {
    fn authorize_selected_path(&self, path: &Path) -> Result<PathBuf, String> {
        WorkspaceFsAccess::authorize_selected_path(self, path)
    }

    fn authorize_selected_paths(&self, selected: &[PathBuf]) -> Result<Vec<String>, String> {
        WorkspaceFsAccess::authorize_selected_paths(self, selected.iter())
    }

    fn authorize_drop_paths(&self, dropped: &[PathBuf]) -> Result<(), String> {
        WorkspaceFsAccess::authorize_drop_paths(self, dropped.iter())
    }
}

mod dto;
mod read;
mod resolve;
mod transfer;
mod write;

use resolve::*;

#[cfg(test)]
mod tests;

pub use dto::*;
pub use read::*;
pub use transfer::*;
pub use write::*;
