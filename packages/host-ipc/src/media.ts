/**
 * 媒体流式地址：桌面壳注册的 `gwmedia://` 自定义协议
 * （实现见 `apps/desktop/src-tauri/src/media_protocol.rs`）。
 *
 * 视频预览**必须**走这条路而不是 blob URL：blob 要求宿主先把整个文件读进内存
 * （IPC 全量传输 + 主线程 `new Blob` 同步拷贝），128MB 的视频就是几秒的界面卡死；
 * 而且 WebKit 要把整个 blob 拉完才开始播、拖动进度条基本废。自定义协议让媒体元素按
 * HTTP Range 自己拉片段，宿主按需吐 1MB。
 *
 * 返回 `null` 表示当前宿主没有这个协议（服务端 / 浏览器预览），调用方回落到读字节。
 * 刻意**不在这里做回落**：回落该读多少字节、走哪条命令是预览层的事，门面只管「有没有」。
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import { runtimeMode } from "./runtime";

/**
 * 协议名。与 `media_protocol.rs` 的 `SCHEME`、`tauri.conf.json` 的 `media-src`
 * 三处必须一致（Rust 侧的漂移测试钉住后两处）。
 */
const MEDIA_SCHEME = "gwmedia";

/**
 * 磁盘文件的流式地址；当前宿主没有该协议时返回 `null`。
 *
 * `convertFileSrc` 会把整条路径 `encodeURIComponent` 后拼在 host 之后：
 * Linux / macOS → `gwmedia://localhost/<encoded>`，
 * Windows / Android → `http://gwmedia.localhost/<encoded>`。两种形态都在 CSP 里放行。
 */
export function mediaStreamUrl(absolutePath: string): string | null {
  if (runtimeMode() !== "desktop" || !absolutePath) return null;
  return convertFileSrc(absolutePath, MEDIA_SCHEME);
}
