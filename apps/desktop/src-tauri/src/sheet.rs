//! 表格文件解析的桌面命令入口；实现收在 `greywork_host::sheet`（与 headless 服务端共用）。

use tauri::State;

pub use greywork_host::sheet::SheetTable;
use greywork_host::workspace_fs::WorkspaceFsAccess;

/// 读取表格文件（`.xls` 等老格式），返回归一化后的字符串网格。
#[tauri::command]
pub fn fs_read_sheet(
    access: State<'_, WorkspaceFsAccess>,
    path: String,
    sheet: Option<String>,
    max_rows: Option<usize>,
) -> Result<SheetTable, String> {
    greywork_host::sheet::fs_read_sheet(&*access, path, sheet, max_rows)
}
