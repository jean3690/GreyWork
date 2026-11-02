//! 内置运行时的探测：`GREYWORK_RUNTIME_DIR` 下的 `bin` 与 `git/cmd` 必须被探测到。
//!
//! 独立集成测试（独立进程）才敢改环境变量 —— 单元测试并行跑，`set_var` 会互相污染。
//! 这里钉住两条打包约定：单文件工具在 `<root>/bin`，Windows MinGit 的 git.exe 在 `<root>/git/cmd`。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 两个测试都要改进程级环境变量：并行跑会互相拔掉对方的变量（曾让探测拿到系统 PATH）。
static ENV_LOCK: Mutex<()> = Mutex::new(());

use greywork_host::process_guard::{is_bundled_program, probe_program, RUNTIME_DIR_ENV};

/// 探测按平台扩展名展开（Windows 上是 PATHEXT），假程序也得按同名写。
fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn write_program(dir: &Path, name: &str) -> PathBuf {
    fs::create_dir_all(dir).expect("建目录");
    let path = dir.join(exe(name));
    fs::write(&path, b"#!/bin/sh\nexit 0\n").expect("写假程序");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("加执行位");
    }
    path
}

#[test]
fn probes_bundled_bin_and_mingit_layout() {
    let _env = ENV_LOCK.lock().expect("env lock");
    let root = std::env::temp_dir().join(format!("greywork-runtime-{}", std::process::id()));
    fs::remove_dir_all(&root).ok();

    let bin = write_program(&root.join("bin"), "rg");
    let git = write_program(&root.join("git").join("cmd"), "git");
    std::env::set_var(RUNTIME_DIR_ENV, &root);

    let found = probe_program("rg", None).expect("内置 bin 里的程序应被探测到");
    assert_eq!(found, bin, "探测结果必须落在捆绑目录里");
    assert!(
        is_bundled_program(&found),
        "来自 runtime 根目录的程序算「内置」"
    );

    let found_git = probe_program("git", None).expect("MinGit 的 git/cmd 也应进 PATH");
    assert_eq!(found_git, git);
    assert!(is_bundled_program(&found_git));

    // 不存在的程序仍返回 None：捆绑不能让「没装」变成假阳性。
    assert!(probe_program("gw-no-such-tool", None).is_none());

    std::env::remove_var(RUNTIME_DIR_ENV);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn missing_runtime_dir_is_not_an_error() {
    let _env = ENV_LOCK.lock().expect("env lock");
    std::env::set_var(RUNTIME_DIR_ENV, "/nonexistent/greywork-runtime");
    // 目录不存在 = 没捆绑：不 panic，也不把 PATH 搞坏。
    assert!(!is_bundled_program(Path::new("/usr/bin/rg")));
    std::env::remove_var(RUNTIME_DIR_ENV);
}
