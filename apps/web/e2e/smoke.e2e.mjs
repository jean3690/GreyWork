/**
 * Web 端全链路冒烟 e2e（无 Rust、无 Electron）：起 vite dev server → headless Chromium 打开 →
 * 经 main.ts 预埋的 window.__gw 钩子往内存 VFS 写入文件 → emit preview:request →
 * 断言预览面板渲染出内容。
 *
 * 覆盖的链：bootstrap → 运行时会话判定 → 壳层挂载 → preview store → 事件桥 → VFS 读取 →
 * Markdown 渲染。与桌面端的 smoke.e2e.mjs 是同一条链，但**不依赖任何原生壳** ——
 * 这正是「Web 端是同一个后端的另一个前端」最小可证的形态。
 *
 * ⚠️ 顺序有讲究：先等预览面板挂载（事件总线在 `PreviewSider` 的 setup 里订阅），
 * 再 emit `preview:request` —— 事件总线不重放，早一步发就是「面板还没开始听」。
 *
 * 依赖 playwright-core（本包已有）+ 本机 Playwright 浏览器缓存（~/.cache/ms-playwright）；
 * 无缓存时先 `npx playwright-core install chromium-headless-shell`。
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// 端口与 apps/desktop 的 smoke e2e（1599）错开：两个前端的 e2e 可能同时跑。
const PORT = 1598;
const BASE = `http://localhost:${PORT}`;
const webRoot = fileURLToPath(new URL("..", import.meta.url));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // 没起来，继续等
    }
    await sleep(400);
  }
  throw new Error(`vite dev server 未在 ${timeoutMs}ms 内就绪: ${url}`);
}

// shell: true 仅 Windows 需要（`pnpm` 装的是 .cmd 垫片）；POSIX 上 detached 让
// pnpm + vite 落在独立进程组里，收尾时可以整组杀掉，避免 vite 子进程握着管道不退出。
const useShell = process.platform === "win32";
const server = spawn("pnpm", ["exec", "vite", "--port", String(PORT), "--strictPort"], {
  cwd: webRoot,
  stdio: ["ignore", "pipe", "pipe"],
  shell: useShell,
  detached: !useShell,
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d.toString()));
server.stderr.on("data", (d) => (serverLog += d.toString()));

/** 停掉 dev server：Windows 用 taskkill /T 清进程树；POSIX 杀整个进程组。 */
async function stopServer() {
  if (!server.pid || server.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
  await Promise.race([new Promise((resolve) => server.once("exit", resolve)), sleep(3000)]);
  if (server.exitCode === null) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      // 已经退出
    }
  }
}

let browser;
try {
  await waitServer(`${BASE}/`, 60_000);

  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__gw), null, { timeout: 30_000 });

  // 前端身份：Web 端必须拿到 WEB_FRONT 的子集，而不是缺省的全量前端。
  // 这条断言才是「一个后端、多个前端」真正落地的证据 —— 侧栏入口/路由都由它派生。
  const front = await page.evaluate(() => window.__gw.front);
  if (front.id !== "web") throw new Error(`前端身份应为 web，实际是 ${front.id}`);
  for (const id of ["guid", "conversation", "automation", "plugins"]) {
    if (!front.features.includes(id)) throw new Error(`WEB_FRONT 缺少特性 ${id}：${front.features.join(",")}`);
  }
  for (const id of ["channels", "team", "assistants"]) {
    if (front.features.includes(id)) throw new Error(`WEB_FRONT 不该包含特性 ${id}`);
  }

  // 先等预览面板挂载（事件订阅发生在它的 setup 里），再注入产物并触发预览。
  await page.locator('[data-testid="preview-section-preview"]').waitFor({ timeout: 20_000 });

  // 工作区种子已有默认文件；写一个 e2e 专属文件，走 preview:request 联动预览面板。
  await page.evaluate(async () => {
    const gw = window.__gw;
    await gw.workspaceFs.writeFile("/e2e/报告.md", "# 城市态势\n\nWeb 端体检通过\n");
    gw.appEvents.emit("preview:request", { path: "/e2e/报告.md" });
  });

  await page.getByText("Web 端体检通过").waitFor({ timeout: 20_000 });

  const shellMounted = await page.evaluate(() => (document.querySelector("#app")?.childElementCount ?? 0) > 0);
  if (!shellMounted) throw new Error("Shell 未能挂载到 #app");

  console.log("SMOKE_OK: web 端启动 → __gw 注入 → preview:request → Markdown 渲染 全链路通");
  if (pageErrors.length > 0) {
    console.warn(`页面捕获 ${pageErrors.length} 个未处理错误（未阻断关键断言）`);
    for (const e of pageErrors.slice(0, 5)) console.warn("  ", e);
  }
} catch (err) {
  console.error("SMOKE_FAIL:", err instanceof Error ? err.message : err);
  console.error("--- vite dev server 日志尾部 ---");
  console.error(serverLog.slice(-2000));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await stopServer();
  // 显式退出：playwright / dev server 的残留句柄不应把 e2e 进程拖到 CI 超时。
  process.exit(process.exitCode ?? 0);
}
