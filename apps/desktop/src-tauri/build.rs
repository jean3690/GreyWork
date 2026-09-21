fn main() {
    let attributes = if target_is_windows_msvc() {
        embed_manifest();
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    } else {
        tauri_build::Attributes::new()
    };

    tauri_build::try_build(attributes).expect("tauri-build 失败");
}

/// 目标平台是不是 Windows/MSVC。判据取 `CARGO_CFG_TARGET_*`（**目标**）而不是
/// `#[cfg(windows)]`：build script 是编给**宿主**的，`#[cfg]` 反映宿主而非目标。
/// tauri 自己的 build.rs 同样用环境变量判。
fn target_is_windows_msvc() -> bool {
    std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
}

/// Windows/MSVC 上自己挂 app manifest，其余平台保持 tauri-build 的默认行为。
///
/// tauri-build 走 tauri-winres → embed-resource::compile，发的是 `rustc-link-arg-bins`，
/// 只有应用主程序拿到 manifest；`cargo test` 生成的测试可执行文件
/// （`target/debug/deps/greywork_lib-*.exe`）拿不到。缺了它进程会加载 ComCtl32 v5，
/// 而 tray-icon / muda 导入的是 v6 才有的入口点，于是测试一启动就
/// `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND` —— 开 `tray-icon` feature 之前不导入那些
/// 入口点，所以这个坑是那时才暴露的（https://github.com/tauri-apps/tauri/issues/13419）。
///
/// 换成不带目标限制的 `cargo:rustc-link-arg`（bin / test / example / bench 全覆盖），
/// 同时用 `new_without_app_manifest` 关掉 tauri 默认那份 —— 否则 bin 会拿到两份 manifest。
/// 这里不跟着发 `/WX`（上游那段 workaround 里有）：单份 manifest 这件事已经由
/// `new_without_app_manifest` 在代码里保证了，而把全部链接器警告升成错误会另外引入
/// 一类与本次修复无关的构建失败。
fn embed_manifest() {
    let manifest =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}
