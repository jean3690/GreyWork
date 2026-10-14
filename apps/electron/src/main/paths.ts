/**
 * 资源解析：开发态与打包态的落点不同，收敛在这里。
 *
 * - **开发态**（`electron .` 跑在仓库里）：sidecar 二进制取 `target/debug/greywork-server`，
 *   渲染层 SPA 取 `apps/desktop/dist`。仓库根靠向上找 `pnpm-workspace.yaml` 定位，不写死层级。
 * - **打包态**：sidecar / SPA / 图标经 electron-builder `extraResources` 落到
 *   `process.resourcesPath` 下（asar 之外，可被 spawn / 读取）。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

/** 仓库根：从当前文件向上找 pnpm-workspace.yaml（开发态）。找不到返回 null。 */
export function repoRoot(): string | null {
  let dir = __dirname;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function requireRepoRoot(): string {
  const root = repoRoot();
  if (!root) throw new Error("无法定位仓库根（向上未找到 pnpm-workspace.yaml）");
  return root;
}

const SERVER_BIN_NAME = process.platform === "win32" ? "greywork-server.exe" : "greywork-server";

/** greywork-server 可执行文件路径。 */
export function serverBinaryPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "server", SERVER_BIN_NAME);
  return path.join(requireRepoRoot(), "target", "debug", SERVER_BIN_NAME);
}

/** 渲染层 SPA 目录（sidecar 的 `GREYWORK_STATIC_DIR`）。 */
export function staticDir(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "static");
  return path.join(requireRepoRoot(), "apps", "desktop", "dist");
}

/** 桌面端前端包目录：dev server（Vite）以它为 cwd 启动。 */
export function desktopDir(): string {
  return path.join(requireRepoRoot(), "apps", "desktop");
}

/** preload 脚本路径（主窗与插件悬浮窗共用同一份白名单桥）。 */
export function preloadPath(): string {
  return path.join(__dirname, "..", "preload", "index.js");
}

/**
 * 托盘图标（apps/electron/resources/icons，electron-builder 会把 32x32.png 带进 resources）。
 */
export function trayIconPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "icons", "32x32.png");
  return path.join(__dirname, "..", "..", "resources", "icons", "32x32.png");
}

/**
 * 插件包落盘根：sidecar（服务端）把已装插件放在 `<dataDir>/plugins/<id>/`
 * （`greywork_host::plugin_market::plugins_root` = `app_data_dir/plugins`）。
 * 插件悬浮窗要读 `plugin.json` 校验窗口声明，所以这里跟 sidecar 用同一个数据目录。
 */
export function pluginsRoot(): string {
  return path.join(app.getPath("userData"), "data", "plugins");
}
