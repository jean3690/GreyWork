/**
 * 桌面专属命令（`desktopOnly: true`）的镜像清单。
 *
 * 这 22 条在共享命令表（`crates/greywork-host/src/app/commands/registry.rs`）里标了
 * `desktop: true`，服务端一律 403 —— 也就是说**只能在 Electron / Tauri 壳里实现**。
 *
 * 为什么在这里再抄一份：Tauri 壳原先靠 `apps/desktop/src-tauri/src/lib.rs` 里一条
 * 「命令名集合 == COMMANDS」的漂移守卫盯着，那个 crate 迟早会被删；这条清单接住那份职责
 * —— `tests/desktop-only.test.ts` 守住它的形状（条数 / 唯一 / 有序），集合本身在迁移时
 * 与 `/api/commands` 的 `desktopOnly` 逐项对拍过（22 == 22）。
 *
 * **全部 22 条都已在本壳实现**。注意 `fs_pick_files` / `pick_workspace_folder` 这两个名字是
 * Tauri 壳「弹窗 + 授权」的单命令形态；Electron 做不到那样（对话框在主进程、授权账本在
 * sidecar），改成等价的两步：`shell:picker:open-*` 弹窗（`main/picker.ts`）+ 渲染端经
 * `fs_authorize_picked_paths` 声明路径（`host-ipc` 的 `hostPicker()` 已把两步串起来）。
 * 能力面齐了，只是不复用那两个命令名。
 */
export const DESKTOP_ONLY_COMMANDS = [
  "browser_back",
  "browser_close",
  "browser_forward",
  "browser_navigate",
  "browser_open",
  "browser_reload",
  "browser_set_bounds",
  "browser_set_visible",
  "browser_stop",
  "close_main_window",
  "confirm_exit",
  "fs_pick_files",
  "open_external",
  "open_path",
  "pick_workspace_folder",
  "plugin_notify",
  "plugin_window_close",
  "plugin_window_open",
  "reveal_path",
  "set_close_to_tray",
  "set_tray_labels",
  "set_unsaved_changes",
] as const;
