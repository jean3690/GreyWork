use base64::Engine as _;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

const MAX_TEXT_BYTES: usize = 10 * 1024 * 1024;
const MAX_BINARY_BYTES: usize = 20 * 1024 * 1024;

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

    /// 解析已存在的授权路径（git.rs 等兄弟模块也要用：它们必须跑在授权根内）。
    pub(crate) fn resolve_existing(&self, raw: &str) -> Result<PathBuf, String> {
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
}

fn validate_absolute(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("只接受绝对路径".into());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("路径不得包含 ..".into());
    }
    Ok(path.to_path_buf())
}

/// 短暂重试的 `rename`：Windows 上目标文件被编辑器/杀软占用一瞬会让它失败。
///
/// 只重试几次、每次间隔很短 —— 授权账本落盘在命令路径上，不能在这里长时间阻塞。
fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    const ATTEMPTS: u32 = 3;
    const DELAY: std::time::Duration = std::time::Duration::from_millis(20);
    let mut result = std::fs::rename(from, to);
    for _ in 1..ATTEMPTS {
        if result.is_ok() {
            break;
        }
        std::thread::sleep(DELAY);
        result = std::fs::rename(from, to);
    }
    result
}

fn canonical_existing(path: &Path) -> Result<PathBuf, String> {
    validate_absolute(path)?;
    std::fs::canonicalize(path).map_err(|error| format!("路径不可访问: {error}"))
}

/// 确保目录存在（产物默认目录等工作区相关落盘前置）。
#[tauri::command]
pub fn fs_ensure_dir(
    access: tauri::State<'_, WorkspaceFsAccess>,
    path: String,
) -> Result<(), String> {
    let path = access.resolve_write(&path)?;
    std::fs::create_dir_all(&path).map_err(|error| format!("创建目录失败: {error}"))
}

/// 写二进制文件（base64 载荷，≤20MB），产物默认落盘通道。
#[tauri::command]
pub fn fs_write_binary(
    access: tauri::State<'_, WorkspaceFsAccess>,
    path: String,
    data_base64: String,
) -> Result<(), String> {
    if data_base64.len() > MAX_BINARY_BYTES {
        return Err("文件超过 20MB 上限".into());
    }
    let path = access.resolve_write(&path)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|error| format!("base64 解码失败: {error}"))?;
    std::fs::write(&path, bytes).map_err(|error| format!("写入文件失败: {error}"))
}

#[derive(Debug, Serialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub kind: String,
    pub size: Option<u64>,
    pub path: String,
}

/// 读取文本文件（10MB 上限），供工作区「打开文件」读取真实磁盘文件。
#[tauri::command]
pub fn fs_read_text_file(
    access: tauri::State<'_, WorkspaceFsAccess>,
    path: String,
) -> Result<String, String> {
    let path = access.resolve_existing(&path)?;
    let metadata = std::fs::metadata(&path).map_err(|error| format!("读取元数据失败: {error}"))?;
    if metadata.len() > MAX_TEXT_BYTES as u64 {
        return Err("文件超过 10MB 上限".into());
    }
    std::fs::read_to_string(&path).map_err(|error| format!("读取文件失败: {error}"))
}

/// 读二进制文件（**原始字节**回传，≤20MB），供右栏预览真实磁盘上的 xlsx / pdf / 图片等。
///
/// 用 `tauri::ipc::Response` 而不是 base64 字符串：base64 把载荷撑大 33%，还要经 JSON
/// 转义、再由前端解码一遍 —— 每次打开预览都付这份开销。这里直接回字节，前端拿到 ArrayBuffer。
///
/// 超过上限是**报错**，不是静默截断 —— 前端会把这句错误原样显示给用户。
#[tauri::command]
pub fn fs_read_binary(
    access: tauri::State<'_, WorkspaceFsAccess>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let path = access.resolve_existing(&path)?;
    let metadata = std::fs::metadata(&path).map_err(|error| format!("读取元数据失败: {error}"))?;
    if metadata.len() > MAX_BINARY_BYTES as u64 {
        return Err("文件超过 20MB 上限".into());
    }
    let bytes = std::fs::read(&path).map_err(|error| format!("读取文件失败: {error}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 写回文本文件（单次 ≤10MB），供编辑器保存时同步到工作区存放文件夹。
#[tauri::command]
pub fn fs_write_text_file(
    access: tauri::State<'_, WorkspaceFsAccess>,
    path: String,
    content: String,
) -> Result<(), String> {
    if content.len() > MAX_TEXT_BYTES {
        return Err("文件超过 10MB 上限".into());
    }
    let path = access.resolve_write(&path)?;
    std::fs::write(&path, content).map_err(|error| format!("写入文件失败: {error}"))
}

/// 浅层列目录；指向授权根之外的符号链接不会暴露给渲染端。
#[tauri::command]
pub fn fs_list_dir(
    access: tauri::State<'_, WorkspaceFsAccess>,
    path: String,
) -> Result<Vec<DirEntryInfo>, String> {
    let path = access.resolve_existing(&path)?;
    let mut out = Vec::new();
    let reader = std::fs::read_dir(&path).map_err(|error| format!("打开目录失败: {error}"))?;
    for entry in reader {
        let entry = entry.map_err(|error| format!("读取目录项失败: {error}"))?;
        let entry_path = entry.path();
        let Ok(canonical) = access.resolve_existing(&entry_path.to_string_lossy()) else {
            continue;
        };
        let metadata = std::fs::metadata(&canonical)
            .map_err(|error| format!("读取目录项元数据失败: {error}"))?;
        let kind = if metadata.is_dir() {
            "directory"
        } else {
            "file"
        };
        out.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: kind.to_string(),
            size: metadata.is_file().then_some(metadata.len()),
            // 剥掉 `\\?\` 再回前端；前端原样回传时宿主会重新 canonicalize，
            // 与账本里的 verbatim 形态仍能对上。
            path: crate::path_safety::strip_verbatim_prefix(&canonical.to_string_lossy()),
        });
    }
    Ok(out)
}

/// 系统文件选择器。路径在返回渲染端前即写入宿主授权账本。
#[tauri::command]
pub async fn fs_pick_files(
    app: tauri::AppHandle,
    access: tauri::State<'_, WorkspaceFsAccess>,
    purpose: String,
    multiple: bool,
) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    if purpose != "attachments" && purpose != "workspace" {
        return Err(format!("未知文件选择用途: {purpose}"));
    }
    let mut dialog = app.dialog().file().set_title("选择文件");
    if purpose == "attachments" {
        dialog = dialog.add_filter(
            "图片与文本",
            &[
                "png", "jpg", "jpeg", "gif", "webp", "bmp", "txt", "md", "markdown", "json", "csv",
                "log", "ts", "tsx", "js", "jsx", "vue", "html", "htm", "css", "scss", "py", "rs",
                "go", "java", "kt", "yml", "yaml", "toml", "xml", "sh", "sql", "ini",
            ],
        );
    }
    let selected = if multiple {
        let (tx, rx) = tokio::sync::oneshot::channel();
        dialog.pick_files(move |paths| {
            let _ = tx.send(paths.unwrap_or_default());
        });
        rx.await
            .map_err(|error| format!("文件选择对话框失败: {error}"))?
            .into_iter()
            .filter_map(|path| path.as_path().map(PathBuf::from))
            .collect::<Vec<_>>()
    } else {
        let (tx, rx) = tokio::sync::oneshot::channel();
        dialog.pick_file(move |path| {
            let _ = tx.send(path);
        });
        rx.await
            .map_err(|error| format!("文件选择对话框失败: {error}"))?
            .and_then(|path| path.as_path().map(PathBuf::from))
            .into_iter()
            .collect::<Vec<_>>()
    };
    access.authorize_selected_paths(&selected)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时间早于 UNIX 纪元")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("greywork-fs-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn access(root: &Path) -> WorkspaceFsAccess {
        WorkspaceFsAccess::new(root, root.parent().unwrap().join("gw-access-test.json"))
            .expect("创建授权状态")
    }

    #[test]
    fn authorization_rejects_sibling_and_parent_traversal() {
        let root = temp_dir("boundary");
        let sibling = root.parent().unwrap().join("greywork-outside.txt");
        std::fs::write(&sibling, b"secret").expect("写外部文件");
        let access = access(&root);
        assert!(access.resolve_existing(&sibling.to_string_lossy()).is_err());
        assert!(access
            .resolve_write(&root.join("../escape.txt").to_string_lossy())
            .is_err());
        let _ = std::fs::remove_file(sibling);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn selected_file_is_exact_not_parent_wide_authorization() {
        let root = temp_dir("exact-root");
        let outside = temp_dir("exact-outside");
        let selected = outside.join("chosen.txt");
        let other = outside.join("other.txt");
        std::fs::write(&selected, b"chosen").expect("写已选文件");
        std::fs::write(&other, b"other").expect("写相邻文件");
        let access = access(&root);
        access
            .authorize_selected_path(&selected)
            .expect("授权选中文件");
        assert!(access.resolve_existing(&selected.to_string_lossy()).is_ok());
        assert!(access.resolve_existing(&other.to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_cannot_escape_authorized_root() {
        use std::os::unix::fs::symlink;
        let root = temp_dir("symlink-root");
        let outside = temp_dir("symlink-outside");
        std::fs::write(outside.join("secret.txt"), b"secret").expect("写外部文件");
        symlink(&outside, root.join("link")).expect("创建符号链接");
        let access = access(&root);
        assert!(access
            .resolve_existing(&root.join("link/secret.txt").to_string_lossy())
            .is_err());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn authorized_root_allows_binary_round_trip_and_listing() {
        let root = temp_dir("roundtrip");
        let access = access(&root);
        let path = root.join("blob.bin");
        let original: Vec<u8> = vec![0x00, 0x01, 0xFE, 0xFF, 0x50, 0x4B, 0x03, 0x04];
        let encoded = base64::engine::general_purpose::STANDARD.encode(&original);
        let write_path = access
            .resolve_write(&path.to_string_lossy())
            .expect("允许写入");
        std::fs::write(
            write_path,
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap(),
        )
        .expect("写二进制");
        let read_path = access
            .resolve_existing(&path.to_string_lossy())
            .expect("允许读取");
        assert_eq!(std::fs::read(read_path).unwrap(), original);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn write_through_symlink_cannot_escape_authorized_root() {
        use std::os::unix::fs::symlink;
        let root = temp_dir("write-link-root");
        let outside = temp_dir("write-link-outside");
        symlink(&outside, root.join("link")).expect("创建符号链接");
        let access = access(&root);
        assert!(access
            .resolve_write(&root.join("link/new.txt").to_string_lossy())
            .is_err());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    /// 建一个目录联接（junction）指向 `target`。
    ///
    /// 用 junction 而不是 symlink：`mklink /J` 不需要 SeCreateSymbolicLinkPrivilege，
    /// 非管理员、未开开发者模式也能建 —— 这既是它在 Windows 上更现实的越界形态，也让用例
    /// 不依赖运行者的特权。两者都是 reparse point，`std::fs::canonicalize` 走
    /// GetFinalPathNameByHandle 一并解析，所以覆盖的是同一条判定路径。
    #[cfg(windows)]
    fn junction(target: &Path, link: &Path) {
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("调用 mklink");
        assert!(
            output.status.success(),
            "创建目录联接失败: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Windows 上目录联接同样不能越出授权根（与 unix 的 symlink 用例对应）。
    #[cfg(windows)]
    #[test]
    fn junction_cannot_escape_authorized_root() {
        let root = temp_dir("junction-root");
        let outside = temp_dir("junction-outside");
        std::fs::write(outside.join("secret.txt"), b"secret").expect("写外部文件");
        junction(&outside, &root.join("link"));
        let access = access(&root);
        assert!(access
            .resolve_existing(&root.join("link/secret.txt").to_string_lossy())
            .is_err());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    /// 写路径上的联接同样不能越界：`resolve_write` 会 canonicalize 最近的存在祖先。
    #[cfg(windows)]
    #[test]
    fn write_through_junction_cannot_escape_authorized_root() {
        let root = temp_dir("junction-write-root");
        let outside = temp_dir("junction-write-outside");
        junction(&outside, &root.join("link"));
        let access = access(&root);
        assert!(access
            .resolve_write(&root.join("link/new.txt").to_string_lossy())
            .is_err());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }
}
