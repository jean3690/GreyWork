/**
 * 可用 shell 探测：移植 `crates/greywork-host/src/infra/terminal/shells.rs`。
 *
 * 只回 id / label（前端按 id 选，后端再按 id 反查可执行路径），spawn 面收在本模块的候选表里。
 * 探测不起进程（纯文件系统命中），所以列一次很便宜。
 *
 * 顺序与 Rust 完全一致 —— 双轨对照（scripts/host-parity.mjs）直接比对这份输出：
 * Unix：$SHELL → /etc/shells → 常见路径兜底；Windows：cmd / pwsh / powershell / Git Bash / WSL / Nushell。
 */
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export interface ShellOption {
  id: string;
  label: string;
  program: string;
  args: string[];
}

export interface ShellCatalog {
  shells: { id: string; label: string }[];
  defaultId: string | null;
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function canonical(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

function unixId(file: string): string {
  return path.basename(file).toLowerCase();
}

function unixLabel(id: string, file: string): string {
  switch (id) {
    case "bash":
      return "Bash";
    case "zsh":
      return "Zsh";
    case "fish":
      return "Fish";
    case "nu":
      return "Nushell";
    case "dash":
      return "Dash";
    case "sh":
      return "POSIX sh";
    default:
      return path.basename(file);
  }
}

function pushUnix(out: ShellOption[], file: string): void {
  if (!isExecutableFile(file)) return;
  const real = canonical(file);
  if (out.some((shell) => canonical(shell.program) === real)) return;
  const id = unixId(file);
  out.push({ id, label: unixLabel(id, file), program: file, args: ["-l"] });
}

function unixShells(): ShellOption[] {
  const out: ShellOption[] = [];
  const envShell = process.env.SHELL?.trim();
  if (envShell) pushUnix(out, envShell);
  try {
    for (const line of readFileSync("/etc/shells", "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      pushUnix(out, trimmed);
    }
  } catch {
    // 容器 / 极简镜像常常没有 /etc/shells：继续走兜底列表。
  }
  for (const file of ["/bin/bash", "/bin/zsh", "/usr/bin/fish", "/opt/homebrew/bin/fish", "/usr/bin/nu", "/bin/sh"]) {
    pushUnix(out, file);
  }
  return out;
}

/** 在 PATH + PATHEXT 上找可执行文件（Windows 用；Unix 也能用，用于 wsl/nu 这类）。 */
function probeProgram(program: string): string | null {
  const pathValue = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((item) => item !== "") : [""];
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir === "") continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, program + extension);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function findGitBash(): string | null {
  for (const key of ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]) {
    const base = process.env[key];
    if (!base) continue;
    for (const rel of ["Git/bin/bash.exe", "Programs/Git/bin/bash.exe"]) {
      const candidate = path.join(base, rel);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  const git = probeProgram("git");
  if (!git) return null;
  const root = path.dirname(path.dirname(git));
  for (const rel of ["bin/bash.exe", "usr/bin/bash.exe"]) {
    const candidate = path.join(root, rel);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function pushWindows(out: ShellOption[], program: string, id: string, label: string, args: string[]): void {
  const real = canonical(program);
  if (out.some((shell) => canonical(shell.program) === real)) return;
  out.push({ id, label, program, args });
}

function windowsShells(): ShellOption[] {
  const out: ShellOption[] = [];
  for (const [program, id, label, args] of [
    ["cmd", "cmd", "命令提示符 (cmd)", []],
    ["pwsh", "pwsh", "PowerShell", ["-NoLogo"]],
    ["powershell", "powershell", "Windows PowerShell", ["-NoLogo"]],
  ] as const) {
    const found = probeProgram(program);
    if (found) pushWindows(out, found, id, label, [...args]);
  }
  const gitBash = findGitBash();
  if (gitBash) pushWindows(out, gitBash, "git-bash", "Git Bash", ["--login", "-i"]);
  const wsl = probeProgram("wsl");
  if (wsl) pushWindows(out, wsl, "wsl", "WSL", []);
  const nu = probeProgram("nu");
  if (nu) pushWindows(out, nu, "nu", "Nushell", []);
  return out;
}

/**
 * 在 PATH（+ Windows 的 PATHEXT）上探测可执行文件；**不 canonicalize**（与 Rust
 * `probe_program` 一致：回的是 PATH 条目拼出来的路径，不是 realpath）。
 * 绝对路径直接检查自身（`Path::join` 遇到绝对路径会替换前项）。
 */
export function probeProgramPath(program: string): string | null {
  const pathValue = process.env.PATH ?? "";
  const candidates =
    process.platform === "win32" && path.extname(program) === ""
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
          .split(";")
          .filter((ext) => ext !== "")
          .map((ext) => program + ext)
      : [program];
  for (const dir of pathValue.split(path.delimiter)) {
    for (const candidate of candidates) {
      if (candidate === "") continue;
      const full = path.isAbsolute(candidate) ? candidate : path.join(dir === "" ? "." : dir, candidate);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

export function detectShells(): ShellOption[] {
  if (process.platform === "win32") return windowsShells();
  if (process.platform === "linux" || process.platform === "darwin") return unixShells();
  return [];
}

export function shellCatalog(): ShellCatalog {
  const shells = detectShells();
  let defaultId: string | null = shells[0]?.id ?? null;
  if (process.platform === "win32") {
    for (const preferred of ["pwsh", "powershell", "cmd"]) {
      if (shells.some((shell) => shell.id === preferred)) {
        defaultId = preferred;
        break;
      }
    }
  }
  return { shells: shells.map(({ id, label }) => ({ id, label })), defaultId };
}
