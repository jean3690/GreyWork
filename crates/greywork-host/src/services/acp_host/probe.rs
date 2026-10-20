//! agent 入口程序探测。

use serde::Serialize;

use crate::process_guard;

/// PATH 探测结果（设置页据此显示「已安装 / 未安装」）。
#[derive(Serialize)]
pub struct AgentProgramProbe {
    program: String,
    installed: bool,
    path: Option<String>,
}

/// 批量探测 ACP agent 入口程序是否在本机 PATH 上（只读，不启动任何进程）。
///
/// 探测失败（命令缺失等）不该让用户以为「没装」，故返回空数组由前端按未知处理。
pub fn acp_detect_programs(programs: Vec<String>) -> Vec<AgentProgramProbe> {
    const MAX_PROGRAMS: usize = 64;
    programs
        .into_iter()
        .filter(|program| !program.trim().is_empty())
        .take(MAX_PROGRAMS)
        .map(|program| {
            let found = process_guard::probe_program(&program, None);
            AgentProgramProbe {
                installed: found.is_some(),
                path: found.map(|p| p.to_string_lossy().into_owned()),
                program,
            }
        })
        .collect()
}
