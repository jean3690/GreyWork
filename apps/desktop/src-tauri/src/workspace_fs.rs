use serde::Serialize;

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
        let metadata = entry.metadata().map_err(|e| format!("读取目录项元数据失败: {e}"))?;
        let kind = if metadata.is_dir() { "directory" } else { "file" };
        out.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: kind.to_string(),
            size: if metadata.is_file() { Some(metadata.len()) } else { None },
            path: entry.path().to_string_lossy().into_owned(),
        });
    }
    Ok(out)
}
