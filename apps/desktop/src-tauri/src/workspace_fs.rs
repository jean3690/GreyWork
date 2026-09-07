use base64::Engine as _;
use serde::Serialize;

/// 确保目录存在（产物默认目录等工作区相关落盘前置）。
#[tauri::command]
pub fn fs_ensure_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("创建目录失败: {e}"))
}

/// 写二进制文件（base64 载荷，≤20MB），产物默认落盘通道。
#[tauri::command]
pub fn fs_write_binary(path: String, data_base64: String) -> Result<(), String> {
    if data_base64.len() > 20 * 1024 * 1024 {
        return Err("文件超过 20MB 上限".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("写入文件失败: {e}"))
}

#[derive(Serialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub kind: String,
    pub size: Option<u64>,
    pub path: String,
}

/// 读取文本文件（10MB 上限），供工作区「打开文件」读取真实磁盘文件。
#[tauri::command]
pub fn fs_read_text_file(path: String) -> Result<String, String> {
    let metadata = std::fs::metadata(&path).map_err(|e| format!("读取元数据失败: {e}"))?;
    if metadata.len() > 10 * 1024 * 1024 {
        return Err("文件超过 10MB 上限".into());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {e}"))
}

/// 读二进制文件（base64 回传，≤20MB），供右栏预览真实磁盘上的 xlsx / pdf / 图片等。
///
/// 与 `fs_read_text_file` 分开而不是统一成一个「读文件」：二进制经 utf-8 解码是**不可逆**
/// 损坏（xlsx 读回即报「文件已损坏」），所以通道必须在调用侧就选定，不能靠猜内容。
/// 上限与 `fs_write_binary` 对称取 20MB —— 预览是「看一眼」，更大的文件该用系统应用打开。
#[tauri::command]
pub fn fs_read_binary(path: String) -> Result<String, String> {
    let metadata = std::fs::metadata(&path).map_err(|e| format!("读取元数据失败: {e}"))?;
    if metadata.len() > 20 * 1024 * 1024 {
        return Err("文件超过 20MB 上限".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// 写回文本文件（单次 ≤10MB），供编辑器保存时同步到工作区存放文件夹。
#[tauri::command]
pub fn fs_write_text_file(path: String, content: String) -> Result<(), String> {
    if content.len() > 10 * 1024 * 1024 {
        return Err("文件超过 10MB 上限".into());
    }
    std::fs::write(&path, content).map_err(|e| format!("写入文件失败: {e}"))
}

/// 浅层列目录（名称 / 类型 / 大小 / 完整路径），供工作区「选择存放文件夹」扫描内容。
#[tauri::command]
pub fn fs_list_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let mut out = Vec::new();
    let reader = std::fs::read_dir(&path).map_err(|e| format!("打开目录失败: {e}"))?;
    for entry in reader {
        let entry = entry.map_err(|e| format!("读取目录项失败: {e}"))?;
        let metadata = entry
            .metadata()
            .map_err(|e| format!("读取目录项元数据失败: {e}"))?;
        let kind = if metadata.is_dir() {
            "directory"
        } else {
            "file"
        };
        out.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: kind.to_string(),
            size: if metadata.is_file() {
                Some(metadata.len())
            } else {
                None
            },
            path: entry.path().to_string_lossy().into_owned(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 唯一临时目录：并行测试之间不能互相踩。
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时间早于 UNIX 纪元")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("greywork-fs-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    /// 二进制往返：写进去的字节要一模一样读回来。
    /// 这是 xlsx / pdf 预览的根基 —— 少一个字节都会让 Univer 报「文件已损坏」。
    #[test]
    fn binary_round_trip_preserves_bytes() {
        let dir = temp_dir("bin");
        let path = dir.join("blob.bin");
        // 含 0x00 与 0xFF：这些字节经 utf-8 解码会被替换，能抓住「误走文本通道」
        let original: Vec<u8> = vec![0x00, 0x01, 0xFE, 0xFF, 0x50, 0x4B, 0x03, 0x04];
        let encoded = base64::engine::general_purpose::STANDARD.encode(&original);

        fs_write_binary(path.to_string_lossy().into_owned(), encoded).expect("写二进制");
        let read_back = fs_read_binary(path.to_string_lossy().into_owned()).expect("读二进制");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(read_back.as_bytes())
            .expect("base64 解码");

        assert_eq!(decoded, original);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_binary_reports_missing_file() {
        let dir = temp_dir("missing");
        let path = dir.join("nope.bin");
        let err = fs_read_binary(path.to_string_lossy().into_owned()).expect_err("应当失败");
        assert!(
            err.contains("读取元数据失败"),
            "错误文案要指明是元数据读取失败：{err}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 列目录要区分文件与目录，并且文件带大小、目录不带。
    #[test]
    fn list_dir_marks_kind_and_size() {
        let dir = temp_dir("list");
        std::fs::create_dir_all(dir.join("sub")).expect("建子目录");
        std::fs::write(dir.join("a.txt"), b"1234").expect("写文件");

        let mut entries = fs_list_dir(dir.to_string_lossy().into_owned()).expect("列目录");
        entries.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "a.txt");
        assert_eq!(entries[0].kind, "file");
        assert_eq!(entries[0].size, Some(4));
        assert_eq!(entries[1].name, "sub");
        assert_eq!(entries[1].kind, "directory");
        assert_eq!(entries[1].size, None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
