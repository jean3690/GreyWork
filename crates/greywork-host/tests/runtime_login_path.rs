//! `init_login_path()` 的 PATH 合并：捆绑目录必须排在登录 shell PATH 之前。
//!
//! 单独一个测试文件（独立进程）：`LOGIN_PATH` 是进程级 `OnceLock`，和同目录的探测测试
//! 放在一起会互相污染 —— 谁先初始化谁赢。
use std::fs;
use std::path::PathBuf;

use greywork_host::process_guard::{effective_path, init_login_path, RUNTIME_DIR_ENV};

fn write_program(dir: &std::path::Path, name: &str) {
    fs::create_dir_all(dir).expect("建目录");
    let path = dir.join(name);
    fs::write(&path, b"#!/bin/sh\nexit 0\n").expect("写假程序");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("加执行位");
    }
}

#[test]
fn login_path_resolution_includes_bundled_dirs() {
    let root = std::env::temp_dir().join(format!("greywork-runtime-login-{}", std::process::id()));
    fs::remove_dir_all(&root).ok();
    write_program(&root.join("bin"), "rg");
    std::env::set_var(RUNTIME_DIR_ENV, &root);
    #[cfg(unix)]
    std::env::set_var("SHELL", "/bin/sh");

    init_login_path();

    // 后台线程解析登录 shell（最多 1.5s）；只等捆绑目录出现，不赌具体耗时。
    let expected = root.join("bin");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut found: Option<Vec<PathBuf>> = None;
    while std::time::Instant::now() < deadline {
        let entries: Vec<PathBuf> = effective_path()
            .map(|value| std::env::split_paths(&value).collect())
            .unwrap_or_default();
        if entries.contains(&expected) {
            found = Some(entries);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    let entries = found.expect("登录 PATH 里应出现捆绑目录");
    assert_eq!(
        entries.first(),
        Some(&expected),
        "捆绑目录必须排在 PATH 最前，拿到 {entries:?}"
    );

    std::env::remove_var(RUNTIME_DIR_ENV);
    fs::remove_dir_all(&root).ok();
}
