/**
 * 入口 HTML 的 CSP 约束守卫。
 *
 * 桌面壳**打包**时，Tauri 会扫描 HTML 里的每个 style 元素并给它注入 nonce，同时把
 * `'nonce-…'` 追加进 style-src；而 CSP 规范规定 style-src 一旦带 nonce，`'unsafe-inline'`
 * 即失效。后果是 CodeMirror / Univer / pdfjs / MapLibre 这些**运行时注入样式**的库被静默
 * 拦下 —— 症状是预览面板布局塌成「只有行号、没有正文」。
 *
 * 首帧兜底底色因此走同源外链 public/boot.css（与 boot.js 同理，那条管的是 script-src）。
 *
 * 这条守卫只拦「又把内联样式写回入口 HTML」这一种回归：它**只在打包态复现**，dev 与
 * 服务端托管的 e2e（served-spa）都看不见，靠人工很难在提交时发现。
 */
import { describe, expect, it } from "vitest";
// 走 Vite 的 `?raw` 拿入口 HTML 原文，而不用 node:fs —— 壳层的 typecheck 程序不（也不该）
// 加载 @types/node，引 node 内建模块会直接报 TS2307 把打包构建卡死。
import html from "../../index.html?raw";

describe("入口 index.html 的 CSP 约束", () => {
  it("不含内联 style 元素（否则 Tauri 的 style-src nonce 会连带拦掉运行时注入的样式）", () => {
    expect(html).not.toMatch(/<style[\s>]/i);
  });

  it("首帧底色走同源外链 boot.css", () => {
    expect(html).toMatch(/<link[^>]+rel="stylesheet"[^>]+href="\/boot\.css"/i);
  });
});
