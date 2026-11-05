/**
 * 回合产物扫描（prompt-done 自动开预览的数据源）。
 *
 * 移植 Rust `services/acp_host/artifacts.rs`：回合成功后按 mtime 扫工作区里
 * 本轮新写/改过的文档类文件，交给前端 `preview:request` 自动开预览。
 *
 * 白名单故意不放 json/txt：agent 回合里改配置、README、锁文件太常见，弹出来是噪音
 * 而不是「交付物」。遍历同步跳过依赖/构建目录与隐藏目录，不跟随符号链接。
 */
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** 与前端查看器能力对齐：文本产物（md/html/csv）+ Office 二进制 + pdf。 */
const TURN_ARTIFACT_EXTS = new Set(["md", "html", "csv", "xlsx", "docx", "pptx", "pdf"]);

/** 遍历时跳过的目录：依赖 / 构建产物 / 缓存。隐藏目录（.git、.cache…）整体跳过。 */
const TURN_ARTIFACT_SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", "coverage", "__pycache__", ".venv", "venv"]);

/** 递归深度上限：产物目录嵌套通常很浅（≤3 层），上限防极端嵌套拖慢回合收尾。 */
const TURN_ARTIFACT_MAX_DEPTH = 8;

/**
 * 是否值得作为回合产物上报：白名单扩展名 + 排除 Office 锁文件（`~$` 前缀）
 * 与隐藏文件（`.name`）。扩展名大小写不敏感。
 */
export function isTurnArtifactFile(filePath: string): boolean {
  const name = path.basename(filePath);
  if (name.startsWith("~$") || name.startsWith(".") || name.endsWith("~")) return false;
  const extension = path.extname(name).slice(1).toLowerCase();
  return TURN_ARTIFACT_EXTS.has(extension);
}

/**
 * 收集 `root` 下自 `sinceMs` 以来 mtime 变化过的白名单文件（绝对路径，字典序）。
 *
 * 目录过滤：隐藏目录与已知噪音目录不进入；符号链接不跟随（防循环与逃逸）。
 * 异步实现（libuv 线程池），不阻塞宿主的事件循环 —— 回合收尾时其他会话仍在流式输出。
 */
export async function scanTurnArtifacts(root: string, sinceMs: number): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > TURN_ARTIFACT_MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // 目录不存在 / 无权限：静默跳过。
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || TURN_ARTIFACT_SKIP_DIRS.has(entry.name)) continue;
        await walk(fullPath, depth + 1);
      } else if (entry.isFile() && isTurnArtifactFile(fullPath)) {
        try {
          const info = await stat(fullPath);
          if (info.mtimeMs >= sinceMs) found.push(fullPath);
        } catch {
          // 读到一半被删除 / 无权限：跳过这一条，不影响整轮扫描。
        }
      }
    }
  }

  await walk(root, 0);
  found.sort();
  return found;
}
