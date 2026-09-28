/**
 * `@greywork/host-ipc` —— 渲染端与宿主之间的唯一 IPC 门面。
 *
 * 全仓只有这个包允许 import `@tauri-apps/api/core` / `@tauri-apps/api/event`：
 * 桌面的 Tauri IPC 与服务端的 HTTP/WS 在这里被抹平成同一套 `invoke` / `listen`，
 * 上层（acp / llm / plugins / editor / workbench）只依赖门面，不感知运行时差异。
 */

export * from "./runtime";
export * from "./invoke";
export * from "./events";
export * from "./session";
export * from "./commands";
