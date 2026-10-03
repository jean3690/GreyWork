use serde::Serialize;

/* ===== 命令入参（dispatch 用；与前端扁平入参对齐） ===== */

#[derive(Debug, Serialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub kind: String,
    pub size: Option<u64>,
    pub path: String,
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

/// 单路径入参（读 / 探测 / 新建 / 删除 / 列目录等）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathArg {
    pub path: String,
}

/// 媒体读取入参。`maxBytes` 由渲染端按 kind 给（视频 128MB），缺省即 20MB；
/// 宿主一律夹紧到 `MAX_MEDIA_BYTES`。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaArg {
    pub path: String,
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

/// 写文本文件入参。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteTextArg {
    pub path: String,
    pub content: String,
}

/// 写二进制文件入参（base64 载荷）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteBinaryArg {
    pub path: String,
    pub data_base64: String,
}

/// 改名 / 复制入参。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferArg {
    pub from: String,
    pub to: String,
}
