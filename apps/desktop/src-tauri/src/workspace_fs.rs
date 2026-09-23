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

/* ===================== 文件树增删改 =====================
 *
 * 全部只作用于**授权根内**、且**操作条目本身而不是符号链接目标**（见 resolve_entry）。
 * 破坏性操作（删除、覆盖式改名）在 UI 侧还有一道确认，宿主这里只守住路径边界与
 * 「不静默覆盖」这两条。
 */

/// 该条目本身是否是符号链接 / Windows 重解析点（不跟随）。
///
/// `list_dir` 里的 `is_link_like` 吃的是 `DirEntry`，按路径判断的场景要单独一份。
fn entry_is_link(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// 新建路径的公共前置：名字安全 + 父目录已存在且在授权根内。返回**条目自身**的路径。
fn resolve_new_entry(access: &WorkspaceFsAccess, raw: &str) -> Result<PathBuf, String> {
    let requested = validate_absolute(Path::new(raw))?;
    let name = requested
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "路径缺少文件名".to_string())?;
    // 渲染端已校验一次；这里再兜一次，免得别处（或手改过的前端）塞进非法名。
    if !crate::path_safety::is_safe_path_segment(name) {
        return Err(format!("名称不可用: {name}"));
    }
    let parent = requested
        .parent()
        .ok_or_else(|| "路径缺少父目录".to_string())?;
    if !parent.exists() {
        return Err("父目录不存在".into());
    }
    let canonical_parent = canonical_existing(parent)?;
    access.require_authorized_root(&canonical_parent)?;
    if !canonical_parent.is_dir() {
        return Err("父目录不是文件夹".into());
    }
    Ok(canonical_parent.join(name))
}

/// 可删除 / 可改名 / 可移动的源条目及其守卫。
fn movable_source(access: &WorkspaceFsAccess, raw: &str) -> Result<PathBuf, String> {
    let requested = validate_absolute(Path::new(raw))?;
    if crate::path_safety::is_filesystem_root(&requested) {
        return Err("不能操作文件系统根目录".into());
    }
    // 绑定进来的工作区根同样不许动：删掉它会让授权账本指向一个不存在的目录，
    // 而且树里本来就点不到根自身（只列它的子项），这条防的是被构造出来的调用。
    if access.is_authorized_root(&requested) {
        return Err("不能移动或删除已授权的工作区根目录".into());
    }
    let entry = access.resolve_entry(raw)?;
    // 断链的符号链接 `exists()` 是 false，但条目确实在 —— 用 symlink_metadata 兜住。
    if !entry.exists() && std::fs::symlink_metadata(&entry).is_err() {
        return Err(format!("路径不存在: {}", entry.display()));
    }
    Ok(entry)
}

/// 新建空文件。父目录必须已存在（不做递归创建，避免手滑造出一串目录）。
fn create_file(access: &WorkspaceFsAccess, raw: &str) -> Result<(), String> {
    let path = resolve_new_entry(access, raw)?;
    // create_new = O_EXCL：撞名会失败而不是覆盖；目标是指向别处的悬空链接同样失败。
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| format!("新建文件失败: {error}"))?;
    Ok(())
}

/// 新建文件夹（`create_dir` 而非 `create_dir_all`：父目录不存在就报错）。
fn create_dir(access: &WorkspaceFsAccess, raw: &str) -> Result<(), String> {
    let path = resolve_new_entry(access, raw)?;
    std::fs::create_dir(&path).map_err(|error| format!("新建文件夹失败: {error}"))
}

/// 改名 / 移动（同一个操作：改名是同目录换名，移动是新目录加原名）。
fn rename_path(access: &WorkspaceFsAccess, from: &str, to: &str) -> Result<(), String> {
    let source = movable_source(access, from)?;
    let target = resolve_new_entry(access, to)?;
    if crate::path_safety::same_path(&source, &target) {
        return Err("新名称与原名称相同".into());
    }
    // Path::starts_with 按组件比较，所以 `/w/a.txt` 不会被 `/w/a.txt.bak` 命中；
    // 这里要拦的是「把目录挪进它自己的子树」。
    if target.starts_with(&source) {
        return Err("不能把文件夹移动到它自己内部".into());
    }
    // 显式挡撞名：Unix 的 rename 会**静默覆盖**普通文件，用户会丢数据。
    if target.exists() {
        return Err(format!("目标已存在: {}", target.display()));
    }
    match std::fs::rename(&source, &target) {
        Ok(()) => Ok(()),
        // EXDEV / ERROR_NOT_SAME_DEVICE：源与目标在不同挂载点，rename 不跨设备。降级为
        // 「复制 + 删除」（见 move_across_devices）。
        Err(error) if is_cross_device(&error) => move_across_devices(&source, &target),
        Err(error) => Err(format!("移动失败: {error}")),
    }
}

/// 是否是「跨挂载点 / 跨卷」错误。Unix 为 `EXDEV`(18)，Windows 为
/// `ERROR_NOT_SAME_DEVICE`(17)，两套 errno 都得认，否则 Windows 上只会笼统报「移动失败」。
fn is_cross_device(error: &std::io::Error) -> bool {
    #[cfg(windows)]
    {
        error.raw_os_error() == Some(17)
    }
    #[cfg(not(windows))]
    {
        error.raw_os_error() == Some(18)
    }
}

/// 跨挂载点移动的降级路径：复制 → 成功后删源。
///
/// 顺序刻意是「先复制、成了再删源」：`rename` 的原子性在这里拿不到，中间态无法完全避免，
/// 但这样中途失败最多留下一个多余的副本，绝不会出现「源已删、目标残缺」的丢数据形态。
/// 复制失败时清掉半成品目标，别让它冒充成功结果。
///
/// **含符号链接的条目拒绝降级**：`copy_entry` 刻意不跟随链接（不把根外内容搬进来），
/// 若照常删源，那些链接会被一并抹掉 —— 那是静默丢数据。宁可报错让用户自己处置。
fn move_across_devices(source: &Path, target: &Path) -> Result<(), String> {
    if has_link_inside(source) {
        return Err("条目内含符号链接，跨磁盘分区移动会丢失这些链接；请改用复制后手动删除".into());
    }
    if let Err(error) = copy_entry(source, target) {
        let _ = remove_entry(target);
        return Err(format!("跨磁盘分区移动失败（复制阶段）: {error}"));
    }
    remove_entry(source).map_err(|error| {
        format!(
            "已复制到目标，但删除源失败: {error} —— 请手动删除 {}",
            source.display()
        )
    })
}

/// 条目自身、或（目录递归地）其内任一条目是否是符号链接 / 重解析点。
///
/// 读不到就当作「有」（保守拒绝）：宁可让用户走复制后手动删除，也不在信息不全时
/// 赌一把把链接删掉。`entry_is_link` 不跟随链接，所以不会顺着链接递归进根外。
fn has_link_inside(path: &Path) -> bool {
    if entry_is_link(path) {
        return true;
    }
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return true;
    };
    if !metadata.is_dir() {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return true;
    };
    entries.into_iter().any(|entry| match entry {
        Ok(entry) => has_link_inside(&entry.path()),
        Err(_) => true,
    })
}

/// 复制条目（文件或目录，递归）。目标必须不存在。
fn copy_path(access: &WorkspaceFsAccess, from: &str, to: &str) -> Result<(), String> {
    let source = movable_source(access, from)?;
    if entry_is_link(&source) {
        // 复制链接会跟随到目标（`fs::copy` 读的是目标内容），链接指向根外时
        // 等于把授权面外的内容搬进树里。不做，也不假装能复刻链接本身。
        return Err("不支持复制符号链接".into());
    }
    let target = resolve_new_entry(access, to)?;
    if target.starts_with(&source) {
        return Err("不能把文件夹复制到它自己内部".into());
    }
    if target.exists() {
        return Err(format!("目标已存在: {}", target.display()));
    }
    copy_entry(&source, &target).map_err(|error| format!("复制失败: {error}"))
}

/// 递归复制。**目录内的符号链接 / 重解析点一律跳过**，不跟随。
///
/// 跟随会把授权根之外的内容搬进来（`list_dir` 之所以只用根内条目，也是因为它对每个
/// 条目单独判链接），环状链接还会让递归无限展开。
fn copy_entry(source: &Path, target: &Path) -> std::io::Result<()> {
    if entry_is_link(source) {
        return Ok(());
    }
    if std::fs::symlink_metadata(source)?.is_dir() {
        std::fs::create_dir(target)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_entry(&entry.path(), &target.join(entry.file_name()))?;
        }
        return Ok(());
    }
    std::fs::copy(source, target).map(|_| ())
}

/// 删除条目（文件 / 目录 / 链接本身，不跟随链接）。
///
/// 用 symlink_metadata：指向目录的符号链接要被当成「文件」删掉链接本身，
/// 而不是递归删掉它指向的目录内容。跨设备移动降级也复用它删源。
fn remove_entry(entry: &Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(entry)?;
    if metadata.is_dir() {
        std::fs::remove_dir_all(entry)
    } else {
        std::fs::remove_file(entry)
    }
}

/// 删除条目。文件夹递归删除（`remove_dir_all` 删的是条目本身，不跟随链接）。
fn delete_path(access: &WorkspaceFsAccess, raw: &str) -> Result<(), String> {
    let entry = movable_source(access, raw)?;
    remove_entry(&entry).map_err(|error| format!("删除失败: {error}"))
}

/// 新建空文件（工作区文件树「新建文件」）。
#[tauri::command]
pub fn fs_create_file(
    access: tauri::State<'_, WorkspaceFsAccess>,
    path: String,
) -> Result<(), String> {
    create_file(&access, &path)
}

/// 新建文件夹（工作区文件树「新建文件夹」）。
#[tauri::command]
pub fn fs_create_dir(
    access: tauri::State<'_, WorkspaceFsAccess>,
    path: String,
) -> Result<(), String> {
    create_dir(&access, &path)
}

/// 改名 / 移动（工作区文件树「重命名 / 剪切后粘贴」）。
#[tauri::command]
pub fn fs_rename_path(
    access: tauri::State<'_, WorkspaceFsAccess>,
    from: String,
    to: String,
) -> Result<(), String> {
    rename_path(&access, &from, &to)
}

/// 复制（工作区文件树「复制后粘贴」，目录递归）。
#[tauri::command]
pub fn fs_copy_path(
    access: tauri::State<'_, WorkspaceFsAccess>,
    from: String,
    to: String,
) -> Result<(), String> {
    copy_path(&access, &from, &to)
}

/// 删除文件或文件夹（工作区文件树「删除」）。
#[tauri::command]
pub fn fs_delete_path(
    access: tauri::State<'_, WorkspaceFsAccess>,
    path: String,
) -> Result<(), String> {
    delete_path(&access, &path)
}

/// 写二进制文件（base64 载荷，≤20MB），产物默认落盘通道。
#[tauri::command]
pub fn fs_write_binary(
    access: tauri::State<'_, WorkspaceFsAccess>,
    path: String,
    data_base64: String,
) -> Result<(), String> {
    // 上限以**解码后的字节数**为准：base64 会把载荷撑大约 4/3，旧实现拿编码串长度
    // 比 20MB，等于把有效上限压到 ~15MB。这里先按编码串长度粗筛一次（避免为一个
    // 超大字符串白分配解码缓冲），再以解码字节数定音。
    let max_encoded = MAX_BINARY_BYTES / 3 * 4 + 8;
    if data_base64.len() > max_encoded {
        return Err("文件超过 20MB 上限".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|error| format!("base64 解码失败: {error}"))?;
    if bytes.len() > MAX_BINARY_BYTES {
        return Err("文件超过 20MB 上限".into());
    }
    let path = access.resolve_write(&path)?;
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
    // strict UTF-8 会把 Windows 记事本默认的 GBK/GB18030（简中「ANSI」）与 UTF-16
    // 文本文件读成乱码或直接报错；按编码嗅探 + 检测解码，统一回 UTF-8。
    crate::text::decode_text_file(&path).map_err(|error| format!("读取文件失败: {error}"))
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

/// 文件探测结果：预览面板据此决定「当文本视图还是二进制占位」以及「能不能就地编辑」。
///
/// 单独一个命令而不是让渲染端嗅探内容，有两个理由：字节在宿主手上（渲染端拿到的
/// 已经是解码后的字符串，乱码里看不出 NUL）；以及大小/编码这些判断只该有一处实现。
#[derive(Debug, Serialize)]
pub struct FileProbe {
    pub size: u64,
    /// 前缀像二进制（NUL / 控制字符占比过高）→ 预览给占位，而不是一屏 U+FFFD。
    pub binary: bool,
    /// 前缀可按 UTF-8 解码。非 UTF-8 只读 —— 写回命令只会写 UTF-8，
    /// 放开编辑等于静默把整份文件转码。
    pub utf8: bool,
    /// 带 UTF-8 BOM；保存时按原样补回（解码时已剥掉）。
    pub bom: bool,
    /// 首个换行是 CRLF；保存时把 `\n` 还原回 `\r\n`，避免整文件行尾被改写。
    pub crlf: bool,
}

/// 探测的实现（与 `#[tauri::command]` 解耦，便于单测）。
fn probe_file(access: &WorkspaceFsAccess, raw: &str) -> Result<FileProbe, String> {
    let path = access.resolve_existing(raw)?;
    let metadata = std::fs::metadata(&path).map_err(|error| format!("读取元数据失败: {error}"))?;
    let prefix = crate::text::read_prefix(&path, crate::text::PROBE_PREFIX_BYTES)
        .map_err(|error| format!("读取文件失败: {error}"))?;
    Ok(FileProbe {
        size: metadata.len(),
        binary: crate::text::looks_binary(&prefix),
        utf8: crate::text::is_utf8_prefix(&prefix),
        bom: crate::text::has_utf8_bom(&prefix),
        crlf: crate::text::uses_crlf(&prefix).unwrap_or(false),
    })
}

/// 探测文件能否按文本预览 / 编辑（只读前 8KB，不把大文件整个读进来）。
#[tauri::command]
pub fn fs_probe_file(
    access: tauri::State<'_, WorkspaceFsAccess>,
    path: String,
) -> Result<FileProbe, String> {
    probe_file(&access, &path)
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
/// 目录项是否可能是「链接 / 重解析点」——只有这类项才可能指向已授权父目录之外。
///
/// unix 上 `readdir` 的 `d_type` 直接带符号链接位，判定不额外发系统调用。
/// Windows 上目录联接（junction）是重解析点，但 `is_symlink()` 未必为真，
/// 故改按 `FILE_ATTRIBUTE_REPARSE_POINT` 判定：宁可多解析一次，也不能放过越界。
/// 取不到元数据时同样按「可能是」处理（保守方向）。
fn is_link_like(entry: &std::fs::DirEntry, file_type: &std::fs::FileType) -> bool {
    if file_type.is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        // `DirEntry::metadata` 在 Windows 复用目录枚举已取回的 WIN32_FIND_DATA，
        // 不额外发系统调用。
        return match entry.metadata() {
            Ok(metadata) => metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0,
            Err(_) => true,
        };
    }
    #[cfg(not(windows))]
    {
        let _ = entry;
        false
    }
}

/// 目录列举的实现（与 `#[tauri::command]` 解耦，便于单测与基准）。
///
/// 逐项 `canonicalize` 是这里的历史开销大头：每个目录项一次全路径解析、一次读锁、
/// 两次字符串分配，万级目录会被放大成万次全路径解析。而父目录已经 `resolve_existing`
/// 过，普通子项必然仍在该已授权目录内，路径由父目录 `join` 即得（父目录已是 canonical
/// 形态，故 join 结果同样是 canonical 的）。只有链接 / 重解析点才回到 `resolve_existing`
/// 走越界校验。
fn list_dir(access: &WorkspaceFsAccess, raw: &str) -> Result<Vec<DirEntryInfo>, String> {
    let dir = access.resolve_existing(raw)?;
    let mut out = Vec::new();
    let reader = std::fs::read_dir(&dir).map_err(|error| format!("打开目录失败: {error}"))?;
    for entry in reader {
        let entry = entry.map_err(|error| format!("读取目录项失败: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取目录项类型失败: {error}"))?;
        let resolved = if is_link_like(&entry, &file_type) {
            let entry_path = dir.join(entry.file_name());
            match access.resolve_existing(&entry_path.to_string_lossy()) {
                Ok(path) => path,
                // 与既有行为一致：越界（或断链）的链接项不出现在列表里。
                Err(_) => continue,
            }
        } else {
            dir.join(entry.file_name())
        };
        let metadata = std::fs::metadata(&resolved)
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
            path: crate::path_safety::strip_verbatim_prefix(&resolved.to_string_lossy()),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn fs_list_dir(
    access: tauri::State<'_, WorkspaceFsAccess>,
    path: String,
) -> Result<Vec<DirEntryInfo>, String> {
    list_dir(&access, &path)
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
    // `media` 是对话附件通道：不限扩展名 —— 通用文件（PDF / 压缩包 / Office 文档）
    // 也要能选，类型判定与限额由渲染端 `lib/attachments.ts` 统一把关。
    if purpose != "media" && purpose != "workspace" {
        return Err(format!("未知文件选择用途: {purpose}"));
    }
    let dialog = app.dialog().file().set_title("选择文件");
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

    /// 快速路径的基本正确性：文件名 / 类型 / 大小 / 路径都要与逐项 canonicalize 时代一致。
    #[test]
    fn list_dir_reports_name_kind_size_and_canonical_path() {
        let root = temp_dir("listdir-shape");
        let access = access(&root);
        std::fs::write(root.join("note.txt"), b"hello").expect("写文件");
        std::fs::create_dir_all(root.join("sub")).expect("建子目录");
        std::fs::write(root.join("sub/deep.txt"), b"x").expect("写子目录文件");

        let canonical_root = std::fs::canonicalize(&root).expect("canonicalize 根目录");
        // `list_dir` 返回前剥掉 Windows 的 `\\?\` 前缀（见 path_safety::strip_verbatim_prefix；
        // 前端要的是可直接回传的普通形态），期望值同样按 strip 后的形态拼。
        let client_root =
            crate::path_safety::strip_verbatim_prefix(&canonical_root.to_string_lossy());
        let client_root = Path::new(&client_root);
        let entries = list_dir(&access, &root.to_string_lossy()).expect("列举目录");
        let mut by_name: Vec<(String, String, Option<u64>, String)> = entries
            .into_iter()
            .map(|entry| (entry.name, entry.kind, entry.size, entry.path))
            .collect();
        by_name.sort();
        assert_eq!(
            by_name,
            vec![
                (
                    "note.txt".to_string(),
                    "file".to_string(),
                    Some(5),
                    client_root.join("note.txt").to_string_lossy().into_owned()
                ),
                (
                    "sub".to_string(),
                    "directory".to_string(),
                    None,
                    client_root.join("sub").to_string_lossy().into_owned()
                ),
            ]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// 越界符号链接仍不得出现在列表里（快速路径只跳过普通项的 canonicalize，
    /// 链接项必须回到 `resolve_existing` 走越界校验）。
    #[cfg(unix)]
    #[test]
    fn list_dir_drops_escaping_symlink_but_keeps_plain_entries() {
        use std::os::unix::fs::symlink;
        let root = temp_dir("listdir-symlink-root");
        let outside = temp_dir("listdir-symlink-outside");
        std::fs::write(outside.join("secret.txt"), b"secret").expect("写外部文件");
        std::fs::write(root.join("plain.txt"), b"plain").expect("写普通文件");
        std::fs::create_dir_all(root.join("sub")).expect("建子目录");
        symlink(&outside, root.join("escape")).expect("创建越界符号链接");
        // 指向授权根内部的链接：仍应出现（且给出解析后的路径）。
        symlink(root.join("sub"), root.join("inside")).expect("创建内部符号链接");

        let access = access(&root);
        let mut names: Vec<String> = list_dir(&access, &root.to_string_lossy())
            .expect("列举目录")
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec!["inside", "plain.txt", "sub"],
            "越界链接应被剔除，普通项与内部链接应保留"
        );
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    /// 宽目录列举耗时。默认 `#[ignore]`，用于性能改动前后的对比测量：
    /// `cargo test --release -- --ignored --nocapture list_dir_wide_directory_timing`
    #[test]
    #[ignore = "性能测量用例，按需手动运行"]
    fn list_dir_wide_directory_timing() {
        const ENTRIES: usize = 4000;
        let root = temp_dir("listdir-wide");
        let access = access(&root);
        for index in 0..ENTRIES {
            std::fs::write(root.join(format!("f{index:05}.txt")), b"x").expect("写文件");
        }
        let raw = root.to_string_lossy().into_owned();

        let started = std::time::Instant::now();
        let baseline = list_dir_baseline(&access, &raw).expect("旧实现列举目录");
        let baseline_elapsed = started.elapsed();

        let started = std::time::Instant::now();
        let current = list_dir(&access, &raw).expect("新实现列举目录");
        let current_elapsed = started.elapsed();

        assert_eq!(current.len(), ENTRIES);
        assert_eq!(baseline.len(), ENTRIES);
        println!(
            "list_dir {ENTRIES} 项 —— 旧(逐项 canonicalize): {baseline_elapsed:?} / 新(仅链接项解析): {current_elapsed:?}"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// 改动前的实现，仅供上面的对比测量保留。
    fn list_dir_baseline(
        access: &WorkspaceFsAccess,
        raw: &str,
    ) -> Result<Vec<DirEntryInfo>, String> {
        let path = access.resolve_existing(raw)?;
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
                path: crate::path_safety::strip_verbatim_prefix(&canonical.to_string_lossy()),
            });
        }
        Ok(out)
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

    /// 探测：文本 / 二进制 / 行尾 / 越界四条一起钉住 —— 预览面板据此决定当文本还是占位。
    #[test]
    fn probe_reports_text_binary_and_newline_style() {
        let root = temp_dir("probe");
        let access = access(&root);

        let text = root.join("notes.txt");
        std::fs::write(&text, "第一行\r\n第二行\r\n").expect("写文本");
        let info = probe_file(&access, &text.to_string_lossy()).expect("探测文本");
        assert!(!info.binary);
        assert!(info.utf8);
        assert!(!info.bom);
        assert!(info.crlf);
        assert_eq!(info.size, "第一行\r\n第二行\r\n".len() as u64);

        let bom = root.join("bom.txt");
        std::fs::write(&bom, [0xEF, 0xBB, 0xBF, b'a']).expect("写 BOM 文件");
        let info = probe_file(&access, &bom.to_string_lossy()).expect("探测 BOM");
        assert!(info.bom);
        assert!(info.utf8);
        assert!(!info.crlf);

        let binary = root.join("blob.bin");
        std::fs::write(&binary, [0x00, 0x01, 0x02, 0x03, 0x00, 0xFF]).expect("写二进制");
        assert!(
            probe_file(&access, &binary.to_string_lossy())
                .expect("探测二进制")
                .binary
        );

        // 授权面与其它读命令一致：越界路径拿不到探测结果。
        let outside = temp_dir("probe-outside");
        let sibling = outside.join("secret.txt");
        std::fs::write(&sibling, b"secret").expect("写外部文件");
        assert!(probe_file(&access, &sibling.to_string_lossy()).is_err());
        assert!(probe_file(&access, &root.join("ghost.txt").to_string_lossy()).is_err());

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    /// 新建：落在授权根内、撞名与非法名被拒、父目录必须存在、不覆盖既有内容。
    #[test]
    fn create_refuses_collisions_illegal_names_and_missing_parents() {
        let root = temp_dir("create");
        let access = access(&root);

        let file = root.join("notes.txt");
        create_file(&access, &file.to_string_lossy()).expect("新建文件");
        assert!(file.is_file());
        assert!(std::fs::read(&file).unwrap().is_empty());

        // 撞名不再新建，更不清空已有内容
        std::fs::write(&file, b"keep").unwrap();
        assert!(create_file(&access, &file.to_string_lossy()).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"keep");

        let dir = root.join("sub");
        create_dir(&access, &dir.to_string_lossy()).expect("新建文件夹");
        assert!(dir.is_dir());
        assert!(create_dir(&access, &dir.to_string_lossy()).is_err());

        // 父目录不存在（不做递归创建）
        assert!(create_file(&access, &root.join("nope/a.txt").to_string_lossy()).is_err());
        // 非法名：保留设备名 / 结尾点 / Windows ADS 的冒号
        for bad in ["CON", "foo.", "a:b"] {
            assert!(
                create_file(&access, &root.join(bad).to_string_lossy()).is_err(),
                "{bad:?} 应被拒绝"
            );
        }
        // 授权根之外 / 相对路径
        let outside = temp_dir("create-outside");
        assert!(create_file(&access, &outside.join("x.txt").to_string_lossy()).is_err());
        assert!(create_file(&access, "relative.txt").is_err());

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    /// 改名 / 移动：同路径、撞名、自身子树、授权根、根外源全部被拒；成功时旧路径消失。
    #[test]
    fn rename_guards_collisions_subtrees_and_roots() {
        let root = temp_dir("rename");
        let access = access(&root);
        let dir = root.join("sub");
        std::fs::create_dir(&dir).unwrap();
        let from = dir.join("a.txt");
        std::fs::write(&from, b"one").unwrap();

        let to = dir.join("b.txt");
        rename_path(&access, &from.to_string_lossy(), &to.to_string_lossy()).expect("改名");
        assert!(!from.exists() && to.is_file());

        // 同路径
        assert!(rename_path(&access, &to.to_string_lossy(), &to.to_string_lossy()).is_err());
        // 撞名（且不能覆盖目标内容）
        std::fs::write(&from, b"two").unwrap();
        assert!(rename_path(&access, &to.to_string_lossy(), &from.to_string_lossy()).is_err());
        assert_eq!(std::fs::read(&from).unwrap(), b"two");

        // 目录挪进自己的子树
        assert!(rename_path(
            &access,
            &dir.to_string_lossy(),
            &dir.join("inner/sub").to_string_lossy()
        )
        .is_err());

        // 跨目录移动
        let moved = root.join("b.txt");
        rename_path(&access, &to.to_string_lossy(), &moved.to_string_lossy()).expect("移动");
        assert!(moved.is_file() && !to.exists());

        // 授权根本身
        let outer = temp_dir("rename-outer");
        assert!(rename_path(
            &access,
            &root.to_string_lossy(),
            &outer.join("renamed").to_string_lossy()
        )
        .is_err());
        // 根之外的源
        let outside = temp_dir("rename-outside");
        let ghost = outside.join("x.txt");
        std::fs::write(&ghost, b"x").unwrap();
        assert!(rename_path(
            &access,
            &ghost.to_string_lossy(),
            &root.join("x.txt").to_string_lossy()
        )
        .is_err());

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
        let _ = std::fs::remove_dir_all(outer);
    }

    /// 复制：目录递归；目录内的符号链接被跳过（不把根外内容搬进来）；链接源被明确拒绝。
    #[test]
    fn copy_is_recursive_and_skips_symlinked_entries() {
        let root = temp_dir("copy");
        let access = access(&root);
        let src = root.join("src");
        std::fs::create_dir_all(src.join("nested")).unwrap();
        std::fs::write(src.join("a.txt"), b"a").unwrap();
        std::fs::write(src.join("nested/b.txt"), b"b").unwrap();

        let dst = root.join("dst");
        copy_path(&access, &src.to_string_lossy(), &dst.to_string_lossy()).expect("复制目录");
        assert_eq!(std::fs::read(dst.join("a.txt")).unwrap(), b"a");
        assert_eq!(std::fs::read(dst.join("nested/b.txt")).unwrap(), b"b");

        // 撞名 / 复制进自己内部
        assert!(copy_path(&access, &src.to_string_lossy(), &dst.to_string_lossy()).is_err());
        assert!(copy_path(
            &access,
            &src.to_string_lossy(),
            &src.join("inner").to_string_lossy()
        )
        .is_err());

        #[cfg(unix)]
        {
            let outside = temp_dir("copy-outside");
            std::fs::write(outside.join("secret.txt"), b"secret").unwrap();
            std::os::unix::fs::symlink(outside.join("secret.txt"), src.join("link.txt")).unwrap();

            let dst2 = root.join("dst2");
            copy_path(&access, &src.to_string_lossy(), &dst2.to_string_lossy())
                .expect("复制目录（含链接）");
            assert!(!dst2.join("link.txt").exists(), "链接不该被复制过去");

            // 源自身是链接：拒绝而不是跟随到目标
            let linked = root.join("linked.txt");
            std::os::unix::fs::symlink(src.join("a.txt"), &linked).unwrap();
            assert!(copy_path(
                &access,
                &linked.to_string_lossy(),
                &root.join("copied.txt").to_string_lossy()
            )
            .is_err());

            let _ = std::fs::remove_dir_all(outside);
        }

        let _ = std::fs::remove_dir_all(root);
    }

    /// 删除：文件与目录（递归）都能删；授权根、文件系统根、根外被拒；软链删的是链接本身。
    #[test]
    fn delete_rejects_roots_and_removes_entries() {
        let root = temp_dir("delete");
        let access = access(&root);
        let file = root.join("a.txt");
        std::fs::write(&file, b"a").unwrap();
        let dir = root.join("d");
        std::fs::create_dir_all(dir.join("inner")).unwrap();
        std::fs::write(dir.join("inner/b.txt"), b"b").unwrap();

        delete_path(&access, &file.to_string_lossy()).expect("删文件");
        assert!(!file.exists());
        delete_path(&access, &dir.to_string_lossy()).expect("删目录");
        assert!(!dir.exists());

        assert!(
            delete_path(&access, &root.to_string_lossy()).is_err(),
            "授权根不可删"
        );
        assert!(delete_path(&access, "/").is_err(), "文件系统根不可删");
        let outside = temp_dir("delete-outside");
        let ghost = outside.join("x.txt");
        std::fs::write(&ghost, b"x").unwrap();
        assert!(delete_path(&access, &ghost.to_string_lossy()).is_err());
        assert!(ghost.exists(), "越界删除不该真的删掉");

        #[cfg(unix)]
        {
            let target = root.join("target.txt");
            std::fs::write(&target, b"keep").unwrap();
            let link = root.join("link.txt");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            delete_path(&access, &link.to_string_lossy()).expect("删软链");
            assert!(
                std::fs::symlink_metadata(&link).is_err(),
                "链接条目应被删掉"
            );
            assert!(target.exists(), "目标文件必须还在");
        }

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    /// 非 ASCII 名称往返：新建 → 改名 → 复制 → 删除。
    #[test]
    fn crud_round_trips_non_ascii_names() {
        let root = temp_dir("unicode");
        let access = access(&root);

        let created = root.join("报告 2026.txt");
        create_file(&access, &created.to_string_lossy()).expect("新建中文名文件");

        let renamed = root.join("总结.md");
        rename_path(
            &access,
            &created.to_string_lossy(),
            &renamed.to_string_lossy(),
        )
        .expect("改名");
        assert!(renamed.is_file());

        let copied = root.join("总结 副本.md");
        copy_path(
            &access,
            &renamed.to_string_lossy(),
            &copied.to_string_lossy(),
        )
        .expect("复制");
        assert!(copied.is_file());

        delete_path(&access, &renamed.to_string_lossy()).expect("删除");
        assert!(!renamed.exists() && copied.exists());

        let _ = std::fs::remove_dir_all(root);
    }

    /// 跨设备降级：内容整棵搬过去，源被删掉。直接测降级函数本身 —— 单元测试里造不出
    /// 第二个挂载点，而这段逻辑与真实设备无关（只有 EXDEV 触发时机依赖设备）。
    #[test]
    fn move_across_devices_copies_then_removes_source() {
        let root = temp_dir("xdev");
        let source = root.join("src");
        std::fs::create_dir_all(source.join("nested")).expect("建源目录");
        std::fs::write(source.join("a.txt"), "hello").expect("写 a");
        std::fs::write(source.join("nested/b.txt"), "world").expect("写 b");
        let target = root.join("dst");

        move_across_devices(&source, &target).expect("跨设备移动降级");

        assert!(!source.exists(), "源应已删除");
        assert_eq!(
            std::fs::read_to_string(target.join("a.txt")).expect("读 a"),
            "hello"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("nested/b.txt")).expect("读 b"),
            "world"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// 目录内含符号链接时拒绝降级，且源保持原样（不静默丢链接）。
    #[cfg(unix)]
    #[test]
    fn move_across_devices_refuses_directory_with_symlink() {
        use std::os::unix::fs::symlink;
        let root = temp_dir("xdev-link");
        let source = root.join("src");
        std::fs::create_dir_all(&source).expect("建源目录");
        std::fs::write(source.join("a.txt"), "hi").expect("写 a");
        symlink("a.txt", source.join("link.txt")).expect("建链接");
        let target = root.join("dst");

        let error = move_across_devices(&source, &target).expect_err("含链接应拒绝");
        assert!(error.contains("符号链接"), "{error}");
        assert!(source.exists(), "拒绝时源必须原样保留");
        assert!(!target.exists(), "拒绝时不该留下目标");
        let _ = std::fs::remove_dir_all(root);
    }

    /// 源本身是符号链接同样拒绝（`copy_entry` 对链接是空操作，删源会直接把链接抹掉）。
    #[cfg(unix)]
    #[test]
    fn move_across_devices_refuses_symlink_source() {
        use std::os::unix::fs::symlink;
        let root = temp_dir("xdev-self-link");
        std::fs::write(root.join("real.txt"), "data").expect("写实体文件");
        let link = root.join("link.txt");
        symlink("real.txt", &link).expect("建链接");
        let target = root.join("dst");

        let error = move_across_devices(&link, &target).expect_err("链接源应拒绝");
        assert!(error.contains("符号链接"), "{error}");
        assert!(std::fs::symlink_metadata(&link).is_ok(), "链接应仍在");
        assert!(root.join("real.txt").exists(), "链接目标应未被牵连");
        let _ = std::fs::remove_dir_all(root);
    }

    /// 跨设备判定按平台 errno：Unix 认 EXDEV(18)，Windows 认 ERROR_NOT_SAME_DEVICE(17)。
    #[test]
    fn is_cross_device_matches_platform_errno() {
        #[cfg(unix)]
        assert!(is_cross_device(&std::io::Error::from_raw_os_error(18)));
        #[cfg(windows)]
        assert!(is_cross_device(&std::io::Error::from_raw_os_error(17)));
        // 无关 errno（ENOENT）不应被误判成跨设备。
        assert!(!is_cross_device(&std::io::Error::from_raw_os_error(2)));
    }
}
