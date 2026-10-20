//! `.agents/prepare`：新快照的准备脚本。

use std::path::Path;

use super::AGENTS_DIR;

/// prepare 脚本的超时上限。Delta 明确要求它「必须快」（每次 provision 都跑），
/// 给一个不拖住隔离环境的硬上限。
const PREPARE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// 组装执行 `.agents/prepare` 的命令：
/// - Unix：文件可执行就直接跑（尊重 shebang），否则交给 `sh`；
/// - Windows：统一走 `cmd /C`（`.cmd`/`.bat` 与无扩展名脚本都能起）。
fn prepare_command(script: &Path) -> std::process::Command {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let executable = std::fs::metadata(script)
            .map(|meta| meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
        if executable {
            std::process::Command::new(script)
        } else {
            let mut cmd = std::process::Command::new("sh");
            cmd.arg(script);
            cmd
        }
    }
    #[cfg(not(unix))]
    {
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/C").arg(script);
        cmd
    }
}

/// 运行 `<checkout>/.agents/prepare`（若存在）。
///
/// 语义与 Delta 一致：脚本负责把新快照配置到可用状态（构建缓存、git 钩子、配置文件）。
/// 失败 / 超时**只告警不失败** —— 快照本身可用，一个坏脚本不该让隔离环境起不来。
///
/// 只在**快照新建时**跑（幂等复用的早返回分支不会到这儿）：脚本的职责是「配置这份
/// checkout」，不是「每个会话跑一次」。
pub(super) fn run_prepare(target: &Path) {
    let script = target.join(AGENTS_DIR).join("prepare");
    if !script.is_file() {
        return;
    }
    let mut cmd = prepare_command(&script);
    crate::process_guard::hide_console_std(&mut cmd);
    cmd.current_dir(target)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null());
    match crate::git::run_capture(&mut cmd, PREPARE_TIMEOUT) {
        Ok(output) if output.status.success() => {}
        Ok(output) => crate::log::warn(
            "worktree",
            format!(
                ".agents/prepare 退出码非零: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ),
        Err(error) => crate::log::warn("worktree", format!(".agents/prepare 执行失败: {error}")),
    }
}
