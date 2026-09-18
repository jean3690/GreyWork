//! 宿主侧文本读取的小工具。

use std::path::Path;

/// UTF-8 BOM（`\u{feff}` 的编码）。
const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// 读文件字节并剥掉开头的 UTF-8 BOM。
///
/// 记事本 / VS Code 的「UTF-8 with BOM」会把这三个字节写在最前面，而 JSON 解析器不认
/// 它们 —— 现象是「用编辑器改过一遍之后，设置/凭据/账本被静默当成损坏并重置」。
/// 配合 `serde_json::from_slice` 使用。
pub fn read_bytes_without_bom(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut bytes = std::fs::read(path)?;
    if bytes.starts_with(UTF8_BOM) {
        bytes.drain(..UTF8_BOM.len());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("greywork-text-{tag}-{}", std::process::id()))
    }

    #[test]
    fn strips_utf8_bom_and_leaves_plain_bytes_alone() {
        let with_bom = temp_path("bom");
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice(b"{\"a\":1}");
        std::fs::write(&with_bom, &bytes).unwrap();
        assert_eq!(read_bytes_without_bom(&with_bom).unwrap(), b"{\"a\":1}");

        let plain = temp_path("plain");
        std::fs::write(&plain, b"{\"a\":1}").unwrap();
        assert_eq!(read_bytes_without_bom(&plain).unwrap(), b"{\"a\":1}");

        // 只有部分 BOM（截断）时不动：宁可让 JSON 解析报错，也不要猜
        let partial = temp_path("partial");
        std::fs::write(&partial, [0xEF, 0xBB, b'{']).unwrap();
        assert_eq!(
            read_bytes_without_bom(&partial).unwrap(),
            [0xEF, 0xBB, b'{']
        );

        // 空文件
        let empty = temp_path("empty");
        std::fs::write(&empty, b"").unwrap();
        assert!(read_bytes_without_bom(&empty).unwrap().is_empty());

        for path in [with_bom, plain, partial, empty] {
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn missing_file_is_an_error_not_an_empty_buffer() {
        let ghost = temp_path("ghost");
        let _ = std::fs::remove_file(&ghost);
        assert!(read_bytes_without_bom(&ghost).is_err());
    }
}
