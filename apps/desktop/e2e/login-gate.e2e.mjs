/**
 * 登录门全链路 e2e：真 Rust 服务端 + 真浏览器（无 Tauri）。
 *
 * 链路：起 `greywork-server`（已知密码、临时数据目录）→ 起 vite dev（`/api` 反代到服务端）
 * → headless Chromium。这是唯一能同时验证「Vite 反代配置 + cookie 同源 + 登录门 + 401 语义」
 * 的手段 —— 单测把 host-ipc 整个 mock 掉了，测不到这三者的接缝。
 *
 * 断言三条关键行为：
 *   1. 服务端态未认证 → 先弹登录门，Shell **不挂载**（否则会先发一批必然 401 的命令）；
 *   2. 密码错误 → 显示服务端返回的文案，仍停在登录门；
 *   3. 密码正确 → 门打开、Shell 挂载；刷新后仍保持登录（HttpOnly cookie 生效）。
 *
 * 依赖：`target/debug/greywork-server`（先 `cargo build -p greywork-server`）、
 * playwright-core（desktop 已有）+ 本机 Playwright 浏览器缓存。
 * 需要 Rust 侧有改动时，本脚本**不会**替你重编，请先手动 build。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const VITE_PORT = 1598;
const SERVER_PORT = 8899;
const BASE = `http://localhost:${VITE_PORT}`;
const PASSWORD = "e2e-login-secret";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const serverBin = fileURLToPath(new URL("../../../target/debug/greywork-server", import.meta.url));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitServer(url, timeoutMs, label) {
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
  throw new Error(`${label} 未在 ${timeoutMs}ms 内就绪: ${url}`);
}

/** 杀掉整个进程组（detached 起的孩子）；尽力而为，失败不影响退出。 */
function killGroup(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // 已经退出了。
    }
  }
}

// 临时数据目录：绝不碰用户真实的 ~/.greyWork-server（db / 通道凭据都在那儿）。
const dataDir = mkdtempSync(join(tmpdir(), "gw-e2e-login-"));

// shell: true —— Windows 上 `pnpm` 是 .cmd 垫片，Node 不带 shell 起不来。
const server = spawn(serverBin, [], {
  cwd: desktopRoot,
  env: {
    ...process.env,
    GREYWORK_BIND: `127.0.0.1:${SERVER_PORT}`,
    GREYWORK_DATA_DIR: dataDir,
    GREYWORK_PASSWORD: PASSWORD,
  },
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d.toString()));
server.stderr.on("data", (d) => (serverLog += d.toString()));

// GREYWORK_SERVER_URL 让 vite 的 /api 反代指向上面这个临时端口的服务端。
//
// 整条命令写成字符串（而不是 args 数组 + shell:true）：Node 对后者会报 DEP0190
// （参数不做转义直接拼接）。这里全是字面量，无注入面。
//
// detached: true —— vite 是经 shell 起的，SIGTERM 只打到 sh 垫片，孙进程会活下来并继续
// 握着 stdout 管道，Node 于是永远等不到 EOF（脚本看起来像卡死，其实断言早跑完了）。
// 独立进程组后可以整组杀。
const vite = spawn(`pnpm exec vite --port ${VITE_PORT} --strictPort`, {
  cwd: desktopRoot,
  env: { ...process.env, GREYWORK_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}` },
  stdio: ["ignore", "pipe", "pipe"],
  shell: true,
  detached: true,
});
let viteLog = "";
vite.stdout.on("data", (d) => (viteLog += d.toString()));
vite.stderr.on("data", (d) => (viteLog += d.toString()));

let browser;
try {
  await waitServer(`http://127.0.0.1:${SERVER_PORT}/api/health`, 30_000, "greywork-server");
  await waitServer(`${BASE}/`, 60_000, "vite dev server");

  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // 1) 未认证：登录门先出，Shell 不挂载。
  await page.locator('[data-testid="login-view"]').waitFor({ timeout: 30_000 });
  if (await page.locator('[data-testid="shell"]').count()) {
    throw new Error("未认证时 Shell 就挂载了：登录门没挡住");
  }
  console.log("OK 1/3 未认证 → 登录门出现，Shell 未挂载");

  // 2) 密码错误：显示服务端文案，仍停在登录门。
  await page.locator('[data-testid="login-password"]').fill("definitely-wrong");
  await page.locator('[data-testid="login-submit"]').click();
  const errorBox = page.locator('[data-testid="login-error"]');
  await errorBox.waitFor({ timeout: 15_000 });
  const errorText = (await errorBox.textContent())?.trim() ?? "";
  if (!errorText) throw new Error("密码错误时没有给出任何提示文案");
  if (await page.locator('[data-testid="shell"]').count()) {
    throw new Error("密码错误却放行了 Shell");
  }
  console.log(`OK 2/3 密码错误 → 停在登录门，文案「${errorText}」`);

  // 3) 密码正确：门打开，Shell 挂载。
  await page.locator('[data-testid="login-password"]').fill(PASSWORD);
  await page.locator('[data-testid="login-submit"]').click();
  await page.locator('[data-testid="shell"]').waitFor({ timeout: 30_000 });
  if (await page.locator('[data-testid="login-view"]').count()) {
    throw new Error("登录成功后登录门没有收起");
  }
  console.log("OK 3/3 密码正确 → 门打开，Shell 挂载");

  // 刷新后仍是登录态：HttpOnly cookie 经同源反代正确往返。
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="shell"]').waitFor({ timeout: 30_000 });
  console.log("OK 刷新后仍保持登录（cookie 同源往返正常）");

  console.log("LOGIN_GATE_OK: 登录门 → 401 文案 → 放行 → 会话保持 全链路通");
  if (pageErrors.length > 0) {
    console.warn(`页面捕获 ${pageErrors.length} 个未处理错误（未阻断关键断言）`);
    for (const e of pageErrors.slice(0, 5)) console.warn("  ", e);
  }
} catch (err) {
  console.error("LOGIN_GATE_FAIL:", err instanceof Error ? err.message : err);
  console.error("--- greywork-server 日志尾部 ---");
  console.error(serverLog.slice(-2000));
  console.error("--- vite dev server 日志尾部 ---");
  console.error(viteLog.slice(-2000));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  killGroup(vite);
  server.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
  // 显式退出：上面的整组杀是尽力而为，这里兜底，保证脚本不会因为残留的管道句柄挂着不退。
  process.exit(process.exitCode ?? 0);
}
