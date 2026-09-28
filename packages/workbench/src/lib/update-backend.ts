/**
 * 检查更新 + 打开外部链接。两条通道，按运行环境自动选：
 *
 * - **manual**（桌面端与服务端）：Rust `check_update` 拉 GitHub 最新 Release（实现在
 *   共享 crate，桌面经 Tauri IPC、服务端经 `POST /api/command`，都是同一个 reqwest 调用），
 *   只做「有没有新版 + 发布说明」展示，「前往下载」打开发布页手动装 —— 桌面用系统浏览器
 *   （opener 插件），服务端/浏览器态用新标签页兜底（`open_external` 是桌面专属命令）。
 *   应用不内置原地升级（不签名、不产 latest.json）。
 * - **unsupported**（浏览器预览态）：没有宿主，没有版本可比对。
 *
 * 检查/打开链接都走宿主：渲染端 CSP 的 connect-src 只放行 self+ipc，直连 GitHub 会被拦。
 */

import { invoke, hasHostCommands, hostVersion, runtimeMode } from "@greywork/host-ipc";
import { getVersion } from "@tauri-apps/api/app";

/** 本项目仓库地址（GitHub 图标点击即跳这里）。 */
export const REPO_URL = "https://github.com/jean3690/GreyWork";

/** Rust `check_update` 的返回：GitHub 最新 Release 的版本号与发布说明。 */
export interface LatestRelease {
  /** 去掉前导 `v` 的版本号，供语义化比较。 */
  version: string;
  tag: string;
  name: string;
  /** 发布说明正文（Markdown 原文，按纯文本展示）。 */
  notes: string;
  /** Release 页面地址。 */
  url: string;
  /** ISO-8601 发布时间，可能为空串。 */
  publishedAt: string;
  prerelease: boolean;
}

/** 更新通道：manual=手动下载；unsupported=浏览器预览态。 */
export type UpdateMode = "manual" | "unsupported";

/** 一次检查的归一结果，喂给对话框决定展示与动作。 */
export interface UpdateStatus {
  mode: UpdateMode;
  hasUpdate: boolean;
  /** 最新版本号（unsupported 时为 null）。 */
  version: string | null;
  /** 当前应用版本（unsupported 时为 null）。 */
  currentVersion: string | null;
  /** 发布说明（Markdown 原文）。 */
  notes: string;
  /** 发布日期（YYYY-MM-DD，可能空）。 */
  date: string;
  /** 手动下载地址（Release 页）。 */
  url: string;
}

export const updateBackend = {
  /** 检查更新是否可用（桌面端与服务端都有宿主；仅浏览器预览态不可）。 */
  supported(): boolean {
    return hasHostCommands();
  },

  /**
   * 当前应用版本：桌面取 Tauri 版本，服务端取启动探测时 `/api/health` 留下的宿主版本
   * （见 host-ipc 的 `hostVersion`）。浏览器预览态没有宿主版本信息，返回 null。
   */
  async currentVersion(): Promise<string | null> {
    if (runtimeMode() === "desktop") return getVersion();
    return hostVersion();
  },

  /** 检查更新：桌面与服务端都走 manual（GitHub 最新 Release），浏览器预览态 unsupported。 */
  async check(): Promise<UpdateStatus> {
    if (!hasHostCommands()) {
      return {
        mode: "unsupported",
        hasUpdate: false,
        version: null,
        currentVersion: null,
        notes: "",
        date: "",
        url: `${REPO_URL}/releases`,
      };
    }
    const current = await this.currentVersion();
    const release = await invoke<LatestRelease>("check_update");
    // current 理论上只在「health 没带版本号」的退化场景为 null；比较函数对空串保守判 false。
    return {
      mode: "manual",
      hasUpdate: isNewerVersion(release.version, current ?? ""),
      version: release.version,
      currentVersion: current,
      notes: release.notes,
      date: release.publishedAt.slice(0, 10),
      url: release.url,
    };
  },

  /** 打开外部链接：桌面用系统默认浏览器；服务端/浏览器态回落到新标签页。 */
  async openExternal(url: string): Promise<void> {
    if (runtimeMode() === "desktop") {
      await invoke("open_external", { url });
      return;
    }
    window.open(url, "_blank", "noopener");
  },
};

/**
 * `latest` 是否比 `current` 新。逐段数值比较（`"0.2.0-beta.1"` → `[0,2,0]`，预发布后缀
 * 不参与），缺段按 0 补齐（`0.2` 视作 `0.2.0`）。任一为空/非法版本时保守返回 false。
 */
export function isNewerVersion(latest: string, current: string): boolean {
  // 先切掉预发布（-）与构建元数据（+）后缀，只比较 major.minor.patch 数字核心：
  // 否则 "0.2.0-beta.1" 会漏出第 4 段 1，被误判成比 "0.2.0" 新。
  const toParts = (version: string): number[] =>
    version
      .split("+")[0]
      .split("-")[0]
      .split(".")
      .map((part) => Number.parseInt(part, 10))
      .filter((n) => Number.isFinite(n));
  const a = toParts(latest);
  const b = toParts(current);
  if (a.length === 0 || b.length === 0) return false;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
