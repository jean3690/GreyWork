/**
 * `acp_detect_programs`：探测一批程序名是否装在本机（PATH + PATHEXT），并标出是否来自
 * 随包运行时（`GREYWORK_RUNTIME_DIR` 前缀）。
 *
 * 上限 64 条、空白项丢弃 —— 与 Rust `probe.rs` 同口径；只做文件系统命中，不起进程。
 */
import path from "node:path";

import { probeProgramPath } from "./shell-catalog.js";

export interface AgentProgramProbe {
  program: string;
  installed: boolean;
  bundled: boolean;
  path: string | null;
}

const MAX_PROGRAMS = 64;

export function detectPrograms(programs: string[]): AgentProgramProbe[] {
  const runtimeDir = process.env.GREYWORK_RUNTIME_DIR;
  return programs
    .filter((program) => program.trim() !== "")
    .slice(0, MAX_PROGRAMS)
    .map((program) => {
      const found = probeProgramPath(program);
      return {
        program,
        installed: found !== null,
        bundled: found !== null && runtimeDir !== undefined && found.startsWith(runtimeDir + path.sep),
        path: found,
      };
    });
}
