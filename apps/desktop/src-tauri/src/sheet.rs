//! 表格文件的宿主解析通道。
//!
//! **为什么在宿主而不是渲染端**：老格式 `.xls` 是 OLE2/BIFF 二进制，渲染端没有任何
//! 可用的解析器 —— exceljs 与 Univer 都只认 xlsx。JS 侧唯一能读它的是 SheetJS，
//! 而它已从 npm 下架（npm 上停在 0.18.5，带两个未修复 CVE）。calamine 是纯 Rust，
//! 一次覆盖 xls / xlsx / xlsb / ods，且不必引入已知漏洞的依赖。
//!
//! **按内容嗅探而非扩展名**：用 `open_workbook_auto_from_rs` 让 calamine 自己试，
//! 于是 `.xlt`（模板）和「名为 .xls 实为 xlsx」这类真实存在的错名文件都能正确读，
//! 不必再像 `LegacyOfficeViewer` 那样提示用户去改名。
//!
//! **只解析，不做表头语义**：首行是否表头由渲染端决定（`lib/tabular.ts` 与 CSV 同口径）。
//! 这里只把单元格值归一成展示字符串。

use std::io::Cursor;

use calamine::{open_workbook_auto_from_rs, Data, ExcelDateTime, Reader, Sheets};
use serde::Serialize;

use crate::workspace_fs::WorkspaceFsAccess;

/// 解析前的字节上限，与 `workspace_fs::fs_read_binary` 对齐 —— 两个通道读的是同一批
/// 文件，上限不一致只会让用户看到「预览能开、分析说文件太大」这种莫名其妙的分歧。
const MAX_SHEET_BYTES: usize = 20 * 1024 * 1024;

/// 回传行数上限。命令结果要经 JSON 走 IPC，不设界的话一张大表能塞出几十 MB
/// 并让渲染端在解析 JSON 时卡住。
const MAX_ROWS: usize = 20_000;

/// 回传列数上限，理由同上。
const MAX_COLS: usize = 128;

/// 一张工作表的内容。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetTable {
    /// 工作簿里全部工作表名（按工作簿顺序），供渲染端做切换器。
    pub sheets: Vec<String>,
    /// 本次返回的是哪一张。
    pub name: String,
    /// 行 × 列的展示字符串网格（含首行）。
    pub rows: Vec<Vec<String>>,
    /// 是否因 `MAX_ROWS` / `MAX_COLS` 被截断。
    pub truncated: bool,
}

/// Excel 日期/时间序列值 → 展示字符串。
///
/// 三种形态分开处理，因为它们的「日期部分」含义不同：
/// - 时长（`[hh]:mm:ss` 格式）没有日期可言，按时长格式化 —— 超过一天时日历分解会串位；
/// - 纯时间（Excel 里 `0.5` 就是 12:00）的整数部分为 0，日历部分同理无意义；
/// - 其余按日期，整点零点只给日期，免得满屏 `2024-01-02 00:00:00` 的噪音。
fn datetime_to_string(stamp: &ExcelDateTime) -> String {
    if stamp.is_duration() {
        let seconds = (stamp.as_f64() * 86_400.0).round().max(0.0) as u64;
        return format!(
            "{:02}:{:02}:{:02}",
            seconds / 3600,
            (seconds / 60) % 60,
            seconds % 60
        );
    }
    let (year, month, day, hour, minute, second, _milli) = stamp.to_ymd_hms_milli();
    let clock = format!("{hour:02}:{minute:02}:{second:02}");
    if stamp.as_f64() < 1.0 {
        return clock;
    }
    if clock == "00:00:00" {
        return format!("{year:04}-{month:02}-{day:02}");
    }
    format!("{year:04}-{month:02}-{day:02} {clock}")
}

/// calamine 单元格值 → 展示字符串。
///
/// 与渲染端 `lib/xlsx-values.ts::cellDisplayValue` 同一立场：只给用户看得见的值。
/// calamine 读到的公式单元格已经是缓存结果，错误值原样给出 `#DIV/0!` 这类 Excel 记法。
fn cell_to_string(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(text) => text.clone(),
        Data::Int(number) => number.to_string(),
        // Rust 的 f64 打印对 1.0 输出 "1"（不是 "1.0"），正好与 Excel 的显示一致。
        Data::Float(number) => number.to_string(),
        Data::Bool(value) => if *value { "TRUE" } else { "FALSE" }.to_string(),
        Data::DateTime(stamp) => datetime_to_string(stamp),
        Data::DateTimeIso(text) | Data::DurationIso(text) => text.clone(),
        Data::Error(error) => error.to_string(),
    }
}

/// 把一张工作表切成有界的字符串网格。
fn table_from_range(range: &calamine::Range<Data>, max_rows: usize) -> (Vec<Vec<String>>, bool) {
    let (total_rows, total_cols) = range.get_size();
    let column_count = total_cols.min(MAX_COLS);
    let truncated = total_rows > max_rows || total_cols > MAX_COLS;
    let rows = range
        .rows()
        .take(max_rows)
        .map(|row| row.iter().take(column_count).map(cell_to_string).collect())
        .collect();
    (rows, truncated)
}

/// 从字节解析出指定工作表。抽成独立函数是为了让单测能直接喂 fixture 字节，
/// 不必构造 Tauri 的 `State`。
fn read_sheet_from_bytes(
    bytes: Vec<u8>,
    sheet: Option<&str>,
    max_rows: usize,
) -> Result<SheetTable, String> {
    let mut workbook: Sheets<Cursor<Vec<u8>>> = open_workbook_auto_from_rs(Cursor::new(bytes))
        .map_err(|error| format!("无法识别表格格式：{error}"))?;

    let sheets = workbook.sheet_names();
    let Some(first) = sheets.first().cloned() else {
        return Err("文件里没有工作表".into());
    };
    let name = match sheet {
        Some(want) if sheets.iter().any(|have| have.as_str() == want) => want.to_string(),
        _ => first,
    };

    let range = workbook
        .worksheet_range(&name)
        .map_err(|error| format!("读取工作表「{name}」失败：{error}"))?;
    let (rows, truncated) = table_from_range(&range, max_rows);
    Ok(SheetTable {
        sheets,
        name,
        rows,
        truncated,
    })
}

/// 读取表格文件（`.xls` 等老格式），返回归一化后的字符串网格。
///
/// 走的是与 `fs_read_binary` 同一套路径授权 —— 解析发生在宿主，不能绕过
/// 「只有用户授权过的路径才可读」这条约束。
#[tauri::command]
pub fn fs_read_sheet(
    access: tauri::State<'_, WorkspaceFsAccess>,
    path: String,
    sheet: Option<String>,
    max_rows: Option<usize>,
) -> Result<SheetTable, String> {
    let path = access.resolve_existing(&path)?;
    let metadata = std::fs::metadata(&path).map_err(|error| format!("读取元数据失败: {error}"))?;
    if metadata.len() > MAX_SHEET_BYTES as u64 {
        return Err("文件超过 20MB 上限".into());
    }
    let bytes = std::fs::read(&path).map_err(|error| format!("读取文件失败: {error}"))?;
    // 上限只收紧不放大：调用方给的值再大也不能突破 MAX_ROWS。
    let limit = max_rows.unwrap_or(MAX_ROWS).min(MAX_ROWS);
    read_sheet_from_bytes(bytes, sheet.as_deref(), limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::{CellErrorType, ExcelDateTimeType};

    fn datetime(value: f64) -> Data {
        Data::DateTime(ExcelDateTime::new(
            value,
            ExcelDateTimeType::DateTime,
            false,
        ))
    }

    fn duration(value: f64) -> Data {
        Data::DateTime(ExcelDateTime::new(
            value,
            ExcelDateTimeType::TimeDelta,
            false,
        ))
    }

    #[test]
    fn cell_to_string_covers_every_variant() {
        assert_eq!(cell_to_string(&Data::Empty), "");
        assert_eq!(cell_to_string(&Data::String("文本".into())), "文本");
        assert_eq!(cell_to_string(&Data::Int(-7)), "-7");
        // 整数型浮点不带 `.0` 尾巴，与 Excel 的显示一致
        assert_eq!(cell_to_string(&Data::Float(10.0)), "10");
        assert_eq!(cell_to_string(&Data::Float(2.5)), "2.5");
        assert_eq!(cell_to_string(&Data::Bool(true)), "TRUE");
        assert_eq!(cell_to_string(&Data::Bool(false)), "FALSE");
        assert_eq!(cell_to_string(&Data::Error(CellErrorType::Div0)), "#DIV/0!");
        assert_eq!(
            cell_to_string(&Data::DateTimeIso("2024-01-02T03:04:05".into())),
            "2024-01-02T03:04:05"
        );
        assert_eq!(cell_to_string(&Data::DurationIso("PT1H".into())), "PT1H");
    }

    #[test]
    fn datetime_cells_are_formatted_by_shape() {
        // 纯日期：整数部分 > 0 且时间为零点 → 只给日期
        assert_eq!(cell_to_string(&datetime(45293.0)), "2024-01-02");
        // 日期 + 时间
        assert_eq!(cell_to_string(&datetime(45293.5)), "2024-01-02 12:00:00");
        // 纯时间（整数部分为 0）不给日历部分
        assert_eq!(cell_to_string(&datetime(0.5)), "12:00:00");
        // 时长按总秒数格式化，跨天不串位
        assert_eq!(cell_to_string(&duration(1.5)), "36:00:00");
        assert_eq!(cell_to_string(&duration(0.25)), "06:00:00");
    }

    #[test]
    fn reads_legacy_xls_fixture() {
        let bytes = include_bytes!("../tests/fixtures/sample.xls").to_vec();
        let table = read_sheet_from_bytes(bytes, None, MAX_ROWS).expect("解析 .xls");

        assert_eq!(table.sheets, vec!["Sheet1".to_string()]);
        assert_eq!(table.name, "Sheet1");
        assert!(!table.truncated);
        assert_eq!(table.rows[0], vec!["name", "qty", "when", "flag"]);
        assert_eq!(
            table.rows[1],
            vec!["alpha", "10", "2024-01-02 03:04:05", "TRUE"]
        );
        // 整数型浮点与假布尔都要按展示形态给出
        assert_eq!(table.rows[2], vec!["beta", "2.5", "2024-06-30", "FALSE"]);
        assert_eq!(table.rows.len(), 4);
    }

    #[test]
    fn unknown_sheet_falls_back_to_first_and_row_limit_truncates() {
        let bytes = include_bytes!("../tests/fixtures/sample.xls").to_vec();
        let table = read_sheet_from_bytes(bytes, Some("不存在的表"), 2).expect("解析 .xls");
        assert_eq!(table.name, "Sheet1");
        assert!(table.truncated, "行数超过上限必须置 truncated");
        assert_eq!(table.rows.len(), 2);
    }

    #[test]
    fn garbage_bytes_are_rejected_with_a_message() {
        let error = read_sheet_from_bytes(b"not a spreadsheet".to_vec(), None, MAX_ROWS)
            .expect_err("非表格字节必须报错");
        assert!(error.contains("无法识别表格格式"), "实际错误：{error}");
    }
}
