/**
 * `@greywork/plugin-types`：插件作者用的纯类型包（零运行时）。
 *
 * 用法（worker 入口）：
 * ```ts
 * import type { GreyworkGlobal, PluginState, RenderFrame } from "@greywork/plugin-types";
 * declare const greywork: GreyworkGlobal;
 * ```
 *
 * 三类契约：
 * - `manifest.ts`：包清单（作者写给宿主看的声明，真源是 Rust 的 validate_package）。
 * - `worker.ts`：worker prelude（`greywork` 全局）与能力签名。
 * - `render.ts`：渲染指令集（SVG 白名单）。
 */
export * from "./manifest";
export * from "./worker";
export * from "./render";
