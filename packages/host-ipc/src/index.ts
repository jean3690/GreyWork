/**
 * `@greywork/host-ipc` —— 渲染端与宿主之间的唯一 IPC 门面。
 *
 * 宿主能力门面（历史：Tauri 壳时代全仓只有这个包允许 import `@tauri-apps/*`，该约束随
 * 「删 Tauri」一并失效）：
 * 桌面的 Tauri IPC 与服务端的 HTTP/WS 在这里被抹平成同一套 `invoke` / `listen`，
 * 上层（acp / llm / plugins / editor / workbench）只依赖门面，不感知运行时差异。
 */

export * from "./runtime";
export * from "./invoke";
export * from "./events";
export * from "./session";
export * from "./commands";
export * from "./media";
export * from "./shell";
