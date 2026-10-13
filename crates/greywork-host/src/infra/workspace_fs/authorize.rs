//! 路径授权命令的实现：把「用户手势产生的路径」纳入授权账本。
//!
//! 宿主壳本可自行授权（Tauri 就在 Rust 侧的 Drop 分支与对话框回调里做），这两条命令服务的是
//! **渲染端能拿到绝对路径、宿主却不知道用户干了什么**的宿主（Electron / 自托管服务端）。
//! 服务端侧由 `policy::TRUSTED_HOST_ONLY` 守着，不可信部署一律 403 —— 否则任何客户端都能
//! 自行扩大可读写范围，`WorkspaceAuthorizer` 的前提就没了。
//!
//! 两条命令的语义刻意不同，对应两种手势的信任程度：
//! - **拖放**只认普通文件：往窗口里拖一个文件夹，不该顺手把整棵目录树授权出去；
//! - **系统选择器**文件与目录都算：目录成为授权根（「添加工作区」要的正是这个）。
//!
//! 对应关系与桌面壳一致：拖放 = `authorize_drop_paths`，选择器 = `authorize_selected_path`。

use std::path::{Path, PathBuf};

use super::WorkspaceFsAccess;

/// OS 拖放：只认普通文件，目录被忽略（不让整批失败）。
pub fn fs_authorize_drop_paths(
    access: &WorkspaceFsAccess,
    paths: Vec<String>,
) -> Result<(), String> {
    let dropped: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    access.authorize_drop_paths(&dropped)
}

/// 系统选择器：文件与目录都授权，返回剥掉 `\\?\` 前缀的规范路径。
///
/// 返回的是规范路径而非入参原样：这个值会被存进工作区记录（`bindWorkspaceFolder`）并在历史
/// 列表里显示，也会被渲染端当绝对路径判定 —— 与桌面壳 `pick_workspace_folder` 的返回一致。
pub fn fs_authorize_picked_paths(
    access: &WorkspaceFsAccess,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let mut authorized = Vec::with_capacity(paths.len());
    for raw in paths {
        let path = access.authorize_selected_path(Path::new(&raw))?;
        authorized.push(crate::path_safety::strip_verbatim_prefix(
            &path.to_string_lossy(),
        ));
    }
    Ok(authorized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时间早于 UNIX 纪元")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("greywork-authorize-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn access(root: &Path) -> WorkspaceFsAccess {
        WorkspaceFsAccess::new(root, root.parent().unwrap().join("gw-authorize-test.json"))
            .expect("创建授权状态")
    }

    #[test]
    fn drop_ignores_directories_but_picked_makes_them_roots() {
        let root = temp_dir("root");
        let outside = temp_dir("outside");
        let file = outside.join("dropped.txt");
        std::fs::write(&file, b"hi").expect("写文件");
        let dir = outside.join("folder");
        std::fs::create_dir_all(&dir).expect("建目录");

        let access = access(&root);
        // 拖放：文件进账本，目录被忽略（不该因为拖了个文件夹就授权整棵树）。
        fs_authorize_drop_paths(
            &access,
            vec![file.to_string_lossy().into(), dir.to_string_lossy().into()],
        )
        .expect("拖放授权");
        assert!(access.resolve_existing(&file.to_string_lossy()).is_ok());
        assert!(
            access.resolve_existing(&dir.to_string_lossy()).is_err(),
            "拖放不该把目录变成授权根"
        );

        // 选择器：目录成为授权根，其下的文件随之可读（「添加工作区」的语义）。
        std::fs::write(dir.join("inner.txt"), b"inside").expect("写目录内文件");
        let picked = fs_authorize_picked_paths(&access, vec![dir.to_string_lossy().into()])
            .expect("选择器授权");
        assert_eq!(picked.len(), 1);
        assert!(access.is_authorized_root(&dir), "选择目录应成为授权根");
        assert!(access
            .resolve_existing(&dir.join("inner.txt").to_string_lossy())
            .is_ok());

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn picked_reports_failure_instead_of_authorizing_partially() {
        let root = temp_dir("missing");
        let missing = root.parent().unwrap().join("greywork-does-not-exist.txt");
        let access = access(&root);
        assert!(
            fs_authorize_picked_paths(&access, vec![missing.to_string_lossy().into()]).is_err(),
            "不存在的路径必须报错，而不是静默跳过"
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
