/**
 * 入口 HTML 的外链约束。
 *
 * 首帧底色与启动脚本必须是**同源外链**，不能内联：打包态下 CSP 的 style-src 一旦带 nonce，
 * `'unsafe-inline'` 即失效，内联样式会被连带拦掉，运行时注入样式的库（CodeMirror / Univer /
 * pdfjs / MapLibre）随之静默失效 —— 完整说明见 apps/desktop/tests/unit/index-html.test.ts。
 *
 * 这里额外锁**根路径**：本端是 base `/` 的那一端，`/boot.js`、`/boot.css`、`/logo.svg` 与共享
 * publicDir（packages/workbench/public）里的文件名一一对应。写错就是不生效的静默失败，
 * 所以逐个钉住。
 */
import { describe, expect, it } from "vitest";
// 走 Vite 的 `?raw` 拿入口 HTML 原文，而不用 node:fs —— 壳层的 typecheck 程序不（也不该）
// 加载 @types/node，引 node 内建模块会直接报 TS2307 把打包构建卡死。
import html from "../../index.html?raw";

describe("入口 index.html", () => {
  it("不含内联 style 元素（否则打包态的 style-src nonce 会连带拦掉运行时注入的样式）", () => {
    expect(html).not.toMatch(/<style[\s>]/i);
  });

  it("首帧底色走同源外链 boot.css", () => {
    expect(html).toMatch(/<link[^>]+rel="stylesheet"[^>]+href="\/boot\.css"/i);
  });

  it("启动打点脚本走同源外链 boot.js", () => {
    expect(html).toMatch(/<script[^>]+src="\/boot\.js"/i);
  });

  it("入口模块指向本端自己的 main.ts", () => {
    expect(html).toMatch(/<script[^>]+type="module"[^>]+src="\/src\/main\.ts"/i);
  });
});
