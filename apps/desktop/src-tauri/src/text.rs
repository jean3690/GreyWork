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

/// 按编码读取文本文件，尽最大努力还原成 UTF-8 字符串。
///
/// `std::fs::read_to_string` 只认 UTF-8，会把 Windows 记事本默认存的 GBK/GB18030
/// （简中「ANSI」）与 UTF-16 文件要么直接报错、要么读成一片乱码/占位符。
/// 这里的顺序：
/// 1. BOM 嗅探（UTF-8 / UTF-16LE / UTF-16BE）—— 有 BOM 就照它解码并剥掉 BOM。
/// 2. 无 BOM 且是合法 UTF-8 —— 直接当 UTF-8（绝大多数现代文件走这条）。
/// 3. 无 BOM 且非 UTF-8 —— chardetng 检测编码（简中 Windows 基本命中 GBK/GB18030），
///    再用检出的编码解码；解码期的非法字节由 encoding_rs 替换成 U+FFFD，不再报错。
pub fn decode_text_file(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    Ok(decode_text_bytes(&bytes))
}

/// `decode_text_file` 的纯字节版本，便于单测直接喂样本。
pub fn decode_text_bytes(bytes: &[u8]) -> String {
    // BOM 优先：Encoding::for_bom 命中时返回编码与 BOM 长度，剥掉 BOM 再解码。
    if let Some((encoding, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, _) = encoding.decode_without_bom_handling(&bytes[bom_len..]);
        return text.into_owned();
    }
    // 无 BOM 的合法 UTF-8：最常见，直接零替换返回。
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_owned();
    }
    // 无 BOM 的非 UTF-8：检测编码（简中 Windows 多为 GBK/GB18030）再解码。
    let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    detector.feed(bytes, true);
    // allow_utf8=Allow：无 BOM 的合法 UTF-8 已在上面截胡，这里的输入必是非 UTF-8，
    // 允许 UTF-8 只是留个兜底出口，不会误伤。
    let encoding = detector.guess(None, chardetng::Utf8Detection::Allow);
    let (text, _) = encoding.decode_without_bom_handling(bytes);
    text.into_owned()
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

    #[test]
    fn decodes_plain_utf8_unchanged() {
        assert_eq!(decode_text_bytes("中文abc".as_bytes()), "中文abc");
        assert_eq!(decode_text_bytes(b""), "");
    }

    #[test]
    fn strips_utf8_bom_when_decoding_text() {
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice("标题\n正文".as_bytes());
        assert_eq!(decode_text_bytes(&bytes), "标题\n正文");
    }

    #[test]
    fn decodes_utf16le_and_utf16be_by_bom() {
        let mut le = vec![0xFF, 0xFE];
        for unit in "中文abc".encode_utf16() {
            le.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_text_bytes(&le), "中文abc");

        let mut be = vec![0xFE, 0xFF];
        for unit in "中文abc".encode_utf16() {
            be.extend_from_slice(&unit.to_be_bytes());
        }
        assert_eq!(decode_text_bytes(&be), "中文abc");
    }

    #[test]
    fn decodes_gbk_without_bom_via_detection() {
        // GBK 编码的「你好世界，这是一段中文测试」—— 简中 Windows 记事本「ANSI」默认。
        // 无 BOM，strict UTF-8 会解码失败；chardetng 应命中 GBK/GB18030 家族。
        let (bytes, encoding, unmappable) = encoding_rs::GBK.encode("你好世界，这是一段中文测试");
        assert_eq!(encoding, encoding_rs::GBK);
        assert!(!unmappable);
        // 前提校验：这串字节本身不是合法 UTF-8，才真正走检测分支。
        assert!(std::str::from_utf8(&bytes).is_err());
        assert_eq!(decode_text_bytes(&bytes), "你好世界，这是一段中文测试");
    }

    #[test]
    fn decode_text_file_reads_gbk_from_disk() {
        let (bytes, _, _) = encoding_rs::GBK.encode("配置项：启用");
        let path = temp_path("gbk-file");
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(decode_text_file(&path).unwrap(), "配置项：启用");
        let _ = std::fs::remove_file(path);
    }
}
