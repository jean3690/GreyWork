/**
 * 检查更新 + 打开外部链接。三条通道，按平台自动选：
 *
 * - **auto**（Windows NSIS / macOS app）：`@tauri-apps/plugin-updater` 拉 `latest.json`、
 *   校验 minisign 签名、下载并原地安装，装完 `plugin-process` 重启。
 * - **manual**（Linux deb）：deb 无原地升级路径，退回 Rust `check_update` 拉 GitHub 最新
 *   Release 只做「有没有新版 + 发布说明」展示，「前往下载」打开发布页手动装。
 * - **unsupported**（浏览器态）：没有宿主，直接告知需要桌面版。
 *
 * 检查/打开链接都走宿主：渲染端 CSP 的 connect-src 只放行 self+ipc，直连 GitHub 会被拦。
 */

import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { isTauriRuntime } from "@greywork/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { hostOs } from "./host-platform";

/** 本项目仓库地址（GitHub 图标点击即跳这里）。 */
export const REPO_URL = "https://github.com/jean3690/GreyWork";

/** Rust `check_update` 的返回：GitHub 最新 Release 的版本号与发布说明（手动通道用）。 */
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

/** 更新通道：auto=应用内安装；manual=手动下载；unsupported=浏览器态。 */
export type UpdateMode = "auto" | "manual" | "unsupported";

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

/** 下载/安装进度：auto 通道 downloadAndInstall 期间回调。 */
export interface DownloadProgress {
  phase: "downloading" | "installing";
  /** 已下载字节。 */
  downloaded: number;
  /** 总字节（服务端没给 Content-Length 时为 0）。 */
  total: number;
}

/** auto 通道 check() 命中的更新句柄，供随后 downloadAndInstall 复用（避免二次查询）。 */
let pendingUpdate: Update | null = null;

export const updateBackend = {
  /** 检查更新是否可用（仅桌面端）。 */
  supported(): boolean {
    return isTauriRuntime();
  },

  /** 当前应用版本；浏览器态没有宿主版本信息，返回 null。 */
  async currentVersion(): Promise<string | null> {
    if (!isTauriRuntime()) return null;
    return getVersion();
  },

  /** 检查更新，按平台走 auto / manual / unsupported 三条通道。 */
  async check(): Promise<UpdateStatus> {
    if (!isTauriRuntime()) {
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
    const current = await getVersion();

    // Linux deb 无 updater 产物，跳过插件直接走手动；win/mac 先试插件。
    if (hostOs.value !== "linux") {
      try {
        const update = await check();
        if (update) {
          pendingUpdate = update;
          return {
            mode: "auto",
            hasUpdate: true,
            version: update.version,
            currentVersion: update.currentVersion || current,
            notes: update.body ?? "",
            date: (update.date ?? "").slice(0, 10),
            url: `${REPO_URL}/releases/tag/v${update.version}`,
          };
        }
        // 插件明确回 null = 已是最新（签名校验也通过了）。
        pendingUpdate = null;
        return {
          mode: "auto",
          hasUpdate: false,
          version: current,
          currentVersion: current,
          notes: "",
          date: "",
          url: `${REPO_URL}/releases`,
        };
      } catch (error) {
        // 插件通道不可用（端点未部署 latest.json / 本平台无产物 / 网络）：不直接判失败，
        // 回落到手动 GitHub 查询，至少让用户看到有没有新版与发布说明。
        console.debug("[update] 自动更新通道不可用，回落手动查询", error);
      }
    }

    // 手动通道：Rust check_update 拉 GitHub 最新 Release。
    const release = await invoke<LatestRelease>("check_update");
    return {
      mode: "manual",
      hasUpdate: isNewerVersion(release.version, current),
      version: release.version,
      currentVersion: current,
      notes: release.notes,
      date: release.publishedAt.slice(0, 10),
      url: release.url,
    };
  },

  /** auto 通道：下载并安装 check() 命中的更新，期间回调进度。装完需 relaunchApp 重启。 */
  async downloadAndInstall(onProgress: (progress: DownloadProgress) => void): Promise<void> {
    if (!pendingUpdate) throw new Error("no-pending-update");
    let downloaded = 0;
    let total = 0;
    await pendingUpdate.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
        onProgress({ phase: "downloading", downloaded: 0, total });
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        onProgress({ phase: "downloading", downloaded, total });
      } else if (event.event === "Finished") {
        onProgress({ phase: "installing", downloaded, total });
      }
    });
  },

  /** 装完重启应用（auto 通道）。 */
  async relaunchApp(): Promise<void> {
    await relaunch();
  },

  /** 用系统默认浏览器打开外部链接；浏览器态回落到新标签页。 */
  async openExternal(url: string): Promise<void> {
    if (!isTauriRuntime()) {
      window.open(url, "_blank", "noopener");
      return;
    }
    await invoke("open_external", { url });
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
