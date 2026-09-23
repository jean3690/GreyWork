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

/// 探测时读取的字节数上限。
///
/// 只用来判断「像不像二进制」「是不是 UTF-8」，前 8KB 足够；与 `MAX_TEXT_BYTES`
/// （能读多少）是两回事 —— 这里决定了要不要读，不该为了探测先把大文件整个搬进内存。
pub const PROBE_PREFIX_BYTES: usize = 8 * 1024;

/// 读文件开头最多 `max` 字节（探测用，不整个读进来）。
pub fn read_prefix(path: &Path, max: usize) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    let mut buffer = Vec::with_capacity(max.min(8 * 1024));
    file.take(max as u64).read_to_end(&mut buffer)?;
    Ok(buffer)
}

/// 前缀是不是 UTF-8 BOM。
pub fn has_utf8_bom(prefix: &[u8]) -> bool {
    prefix.starts_with(UTF8_BOM)
}

/// 前缀能否按 UTF-8 解码。
///
/// **末尾被截断的半个多字节字符不算失败**（`error_len() == None` 表示「输入意外结束」）：
/// 前缀是按固定字节数切的，多字节字符正好跨在边界上是常态，若判成非 UTF-8，
/// 一大批正常文件会被锁成只读。
pub fn is_utf8_prefix(prefix: &[u8]) -> bool {
    match std::str::from_utf8(prefix) {
        Ok(_) => true,
        Err(error) => error.error_len().is_none(),
    }
}

/// 前缀里的首个换行是 CRLF 吗。
///
/// `None` = 前缀里没有换行，调用方按 LF 处理。用于保存时还原行尾：
/// CodeMirror 的 `doc.toString()` 一律用 `\n` 拼接，直接写回会把 CRLF 文件整篇改成 LF，
/// 在 Windows 工作区里表现为「我只改了一行，却整个文件都变了」。
pub fn uses_crlf(prefix: &[u8]) -> Option<bool> {
    for (index, byte) in prefix.iter().enumerate() {
        match byte {
            b'\n' => return Some(index > 0 && prefix[index - 1] == b'\r'),
            // 单独的 `\r`（老 Mac 行尾）不当作 CRLF：保存时保持 LF 即可。
            b'\r' => return Some(prefix.get(index + 1) == Some(&b'\n')),
            _ => {}
        }
    }
    None
}

/// 前缀看起来是不是二进制内容。
///
/// 为什么需要它：未知扩展名一律按文本读（`decode_text_bytes` 对非法字节只做 U+FFFD
/// 替换、**永不报错**），于是 `.zip` / `.exe` / `.woff` 打开就是一屏占位符，
/// 用户以为文件坏了。这里先判一次，让预览给出「二进制文件」的占位。
///
/// 判据（命中任一即二进制）：
/// - 含 `0x00`，但**排除 UTF-16 形态** —— UTF-16 的 ASCII 段天然是「字符 + 0x00」交替，
///   有 BOM 或隔位成片为 0 的都放行给解码器（`decode_text_bytes` 认这两种）。
/// - 控制字符（除 `\t \n \r \x0c` 外）占比超过 30%。
pub fn looks_binary(prefix: &[u8]) -> bool {
    if prefix.is_empty() {
        return false;
    }
    if prefix.starts_with(&[0xFF, 0xFE]) || prefix.starts_with(&[0xFE, 0xFF]) {
        return false;
    }
    if prefix.contains(&0x00) && !looks_utf16(prefix) {
        return true;
    }
    let control = prefix.iter().filter(|byte| is_control(**byte)).count();
    control * 10 > prefix.len() * 3
}

/// 控制字符：ASCII 里除 `\t`(09) `\n`(0a) `\r`(0d) `\x0c`(0c) 之外的都是。
///
/// **不含 `0x00`**：NUL 由 `looks_binary` 里单独那条判据管，算进占比会把 UTF-16 的
/// 「字符 + 0x00」填充全部数成控制字符，把合法的 UTF-16 文本判死（放行 NUL 判据之后
/// 又被这一条拦住）。
fn is_control(byte: u8) -> bool {
    matches!(byte, 0x01..=0x08 | 0x0b | 0x0e..=0x1f | 0x7f)
}

/// 前缀是不是 UTF-16 形态（无 BOM 时用）：某一侧（奇位或偶位）几乎全是 `0x00`，
/// 说明字节被「字符 + 0x00」成对排布 —— UTF-16LE 是奇数位，UTF-16BE 是偶数位。
fn looks_utf16(prefix: &[u8]) -> bool {
    let sample = &prefix[..prefix.len().min(64)];
    // 太短说明不了任何问题，别拿 2 个字节去断言编码。
    if sample.len() < 4 {
        return false;
    }
    let odd_nul = sample.iter().skip(1).step_by(2).filter(|byte| **byte == 0).count();
    let even_nul = sample.iter().step_by(2).filter(|byte| **byte == 0).count();
    let side = sample.len() / 2;
    odd_nul * 10 >= side * 9 || even_nul * 10 >= side * 9
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

    #[test]
    fn plain_text_is_not_binary() {
        assert!(!looks_binary(b""));
        assert!(!looks_binary("第一行\n第二行\tok\r\n".as_bytes()));
        assert!(!looks_binary(br#"{"a": 1, "b": [2, 3]}"#));
        // 只有 \x0c / \x1b 之类零星控制字符，不该被判成二进制
        assert!(!looks_binary(b"page\x0cbreak\x1b[0m"));
    }

    #[test]
    fn nul_bytes_mean_binary() {
        // PNG 头 + 后面的 NUL
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend_from_slice(&[0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
        assert!(looks_binary(&png));
        // 高比例控制字符但没有 NUL：也算二进制
        assert!(looks_binary(&[0x01u8; 64]));
    }

    #[test]
    fn utf16_is_text_not_binary() {
        // 有 BOM 的 UTF-16LE（ASCII 段，交替 NUL）
        let mut le = vec![0xFF, 0xFE];
        for unit in "hello world".encode_utf16() {
            le.extend_from_slice(&unit.to_le_bytes());
        }
        assert!(!looks_binary(&le));
        // 无 BOM 的 UTF-16BE：偶数位全 0
        let mut be = Vec::new();
        for unit in "hello world".encode_utf16() {
            be.extend_from_slice(&unit.to_be_bytes());
        }
        assert!(!looks_binary(&be));
        // 含中文的 UTF-16LE 没有 NUL，本来就不会命中
        let mut cjk = vec![0xFF, 0xFE];
        for unit in "中文测试".encode_utf16() {
            cjk.extend_from_slice(&unit.to_le_bytes());
        }
        assert!(!looks_binary(&cjk));
    }

    #[test]
    fn utf8_prefix_tolerates_a_truncated_final_char() {
        assert!(is_utf8_prefix(b"hello"));
        assert!(is_utf8_prefix("中文abc".as_bytes()));
        assert!(is_utf8_prefix(b""));
        // 「中」是 3 字节，只留前 2 字节 —— 属于「输入意外结束」，仍应认为可当 UTF-8 处理
        let full = "中".as_bytes();
        assert!(is_utf8_prefix(&full[..2]));
        // 真正的非法字节（GBK 的「你」是 C4 E3，不是合法 UTF-8 序列）
        assert!(!is_utf8_prefix(&[0xC4, 0xE3, 0xBA, 0xC3]));
    }

    #[test]
    fn utf8_bom_is_detected() {
        assert!(has_utf8_bom(&[0xEF, 0xBB, 0xBF, b'a']));
        assert!(!has_utf8_bom(b"abc"));
        assert!(!has_utf8_bom(&[0xEF, 0xBB]));
    }

    #[test]
    fn newline_style_from_prefix() {
        assert_eq!(uses_crlf(b"a\r\nb"), Some(true));
        assert_eq!(uses_crlf(b"a\nb"), Some(false));
        assert_eq!(uses_crlf(b"a\rb"), Some(false));
        assert_eq!(uses_crlf(b"no newline here"), None);
        assert_eq!(uses_crlf(b""), None);
    }

    #[test]
    fn read_prefix_only_reads_the_requested_bytes() {
        let path = temp_path("prefix");
        std::fs::write(&path, b"0123456789").unwrap();
        assert_eq!(read_prefix(&path, 4).unwrap(), b"0123");
        // 上限大于文件长度时给全部，不报错
        assert_eq!(read_prefix(&path, 1024).unwrap(), b"0123456789");
        let _ = std::fs::remove_file(path);
    }
}
