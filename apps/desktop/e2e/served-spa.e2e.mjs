/**
 * 服务端托管 SPA 的零 CSP 违规 e2e：**不起 vite**，直接打 `greywork-server` 的静态托管。
 *
 * 为什么必须单独有一条：`login-gate.e2e.mjs` 走 vite dev，dev 态的 CSP 与生产完全无关
 * （vite 注入 inline script / eval、HMR websocket、dev 专用 sourcemap 都会被生产 CSP 拦下）。
 * 换句话说，CSP 只有在**真正托管的产物**上验证才有意义 —— 这条 e2e 就是那个验收闸。
 *
 * 链路：真 Rust 服务端（`GREYWORK_STATIC_DIR=apps/desktop/dist`）→ headless Chromium
 * → 装 `securitypolicyviolation` 收集器 → 登录 → 经文件树打开四类重路径样本
 * （markdown / html(srcdoc) / pdf(pdf.js worker+wasm) / xlsx(Univer canvas)）→
 * **断言违规数为 0**。
 *
 * 另有一条带外（Node fetch）的头部断言：CSP 只在「浏览器真的没报违规」时才算通过，
 * 但「头到底发没发」得绕开浏览器才看得准（页内读不到自己的响应头）。
 *
 * 依赖：`target/debug/greywork-server`（先 `cargo build -p greywork-server`）、
 * `apps/desktop/dist/index.html`（先 `pnpm --filter @greywork/desktop build`）、
 * playwright-core（desktop 已有）+ 本机 Playwright 浏览器缓存。
 * 本脚本**不会**替你构建，缺产物直接报错并提示命令。
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const PORT = 8898;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "e2e-served-secret";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const serverBin = join(repoRoot, "target/debug/greywork-server");
const distDir = join(desktopRoot, "dist");
const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));

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

/**
 * 服务端不经 shell（直接 exec 二进制），所以普通 SIGTERM 就够 —— 没有 `sh` 垫片，
 * 也就没有「孙进程握着 stdout 管道让 Node 等不到 EOF」那个坑。
 */
function killServer(child) {
  try {
    child.kill("SIGTERM");
  } catch {
    // 已经退出了。
  }
}

/** 缺产物时的提示要能直接照抄执行 —— 否则这条 e2e 只会被当成「环境坏了」。 */
function requireArtifacts() {
  const missing = [];
  if (!existsSync(serverBin)) missing.push(`  cargo build -p greywork-server   # 缺 ${serverBin}`);
  if (!existsSync(join(distDir, "index.html"))) {
    missing.push(`  pnpm --filter @greywork/desktop build   # 缺 ${join(distDir, "index.html")}`);
  }
  if (missing.length > 0) {
    throw new Error(`缺少构建产物，先跑：\n${missing.join("\n")}`);
  }
}

/** 带外读响应头：页内看不到自己的响应头，只能另发一条请求。 */
async function fetchHead(path, method = "GET") {
  const res = await fetch(`${BASE}${path}`, { method, redirect: "manual" });
  return { status: res.status, headers: res.headers, body: method === "GET" ? await res.text() : "" };
}

const dataDir = mkdtempSync(join(tmpdir(), "gw-e2e-served-data-"));
const homeDir = mkdtempSync(join(tmpdir(), "gw-e2e-served-home-"));

let server;
let browser;
let serverLog = "";

try {
  requireArtifacts();

  // 样本种进宿主私有数据根（`store_default_root` = <home_dir>/.greyWork）：
  // 文件树默认就绑在这个根上，不需要先「绑定文件夹」。
  const storeRoot = join(homeDir, ".greyWork");
  mkdirSync(storeRoot, { recursive: true });
  for (const name of ["sample.md", "sample.html", "sample.pdf", "sample.xlsx"]) {
    cpSync(join(fixturesDir, name), join(storeRoot, name));
  }

  server = spawn(serverBin, [], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      GREYWORK_BIND: `127.0.0.1:${PORT}`,
      GREYWORK_DATA_DIR: dataDir,
      GREYWORK_HOME_DIR: homeDir,
      GREYWORK_STATIC_DIR: distDir,
      GREYWORK_PASSWORD: PASSWORD,
      // 沙盒在容器/CI 里不可用，显式关掉：这条 e2e 只关心 CSP，不想让探针噪音干扰。
      GREYWORK_SANDBOX: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  server.stdout.on("data", (d) => (serverLog += d.toString()));
  server.stderr.on("data", (d) => (serverLog += d.toString()));

  await waitServer(`${BASE}/api/health`, 30_000, "greywork-server");

  /* ===== 1) 带外头部断言 ===== */
  const indexHtml = readFileSync(join(distDir, "index.html"), "utf8");
  const entryMatch = indexHtml.match(/src="(\/assets\/[^"]+\.js)"/);
  if (!entryMatch) throw new Error("dist/index.html 里找不到入口 JS（/assets/*.js），产物形态变了？");
  const entryJs = entryMatch[1];

  const root = await fetchHead("/");
  if (root.status !== 200) throw new Error(`GET / 状态码 ${root.status}`);
  if (!root.body.includes('id="app"')) throw new Error('GET / 没有返回 SPA 外壳（缺 id="app"）');
  if (root.headers.get("cache-control") !== "no-cache") {
    throw new Error(`GET / 的 Cache-Control 应为 no-cache，实际 ${root.headers.get("cache-control")}`);
  }
  if (!root.headers.get("content-security-policy")) throw new Error("GET / 没有 CSP 头");

  const asset = await fetchHead(entryJs);
  if (asset.status !== 200) throw new Error(`GET ${entryJs} 状态码 ${asset.status}`);
  if (!(asset.headers.get("cache-control") ?? "").includes("immutable")) {
    throw new Error(`入口 JS 的 Cache-Control 应含 immutable，实际 ${asset.headers.get("cache-control")}`);
  }

  const health = await fetchHead("/api/health");
  if (health.headers.get("cache-control") !== "no-store") {
    throw new Error(`/api/health 的 Cache-Control 应为 no-store，实际 ${health.headers.get("cache-control")}`);
  }
  if (!health.headers.get("content-security-policy")) throw new Error("/api/health 没有 CSP 头");

  const missing = await fetchHead("/definitely-missing.js");
  if (missing.status !== 404) throw new Error(`未知静态路径应 404，实际 ${missing.status}`);
  if (missing.body.includes('id="app"')) throw new Error("未知静态路径回落到了 index.html（不该有 SPA catch-all）");
  console.log(`OK 1/5 头部契约：/ → no-cache+CSP，${entryJs} → immutable，/api/health → no-store+CSP，未知 → 404`);

  /* ===== 2) 浏览器：装收集器 → 登录 → 走重路径 ===== */
  browser = await chromium.launch();
  const page = await browser.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  // 留 stack 而不是只有 message：这条断言是「零页面错误」的硬闸，只给一句
  // `TypeError: t.destroy is not a function`（压缩后的产物）根本定位不到来源。
  page.on("pageerror", (err) => pageErrors.push(err.stack ?? String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("requestfailed", (req) => {
    // 只盯同源：跨源失败（比如我们没配的云端 Office）不是这条 e2e 的职责。
    if (req.url().startsWith(BASE)) failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });

  // 必须在导航前装：CSP 违规多数发生在首个文档的解析/子资源加载期。
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__csp.push({
        directive: event.effectiveDirective,
        blockedURI: event.blockedURI,
        source: event.sourceFile,
        line: event.lineNumber,
      });
    });
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // 登录门（testid 与 login-gate.e2e.mjs 一致）。
  await page.locator('[data-testid="login-view"]').waitFor({ timeout: 30_000 });
  await page.locator('[data-testid="login-password"]').fill(PASSWORD);
  await page.locator('[data-testid="login-submit"]').click();
  await page.locator('[data-testid="shell"]').waitFor({ timeout: 30_000 });
  console.log("OK 2/5 登录门放行，Shell 挂载");

  // 预览面板默认折叠（`preview.collapsed` 初值 true），先展开。
  await page.locator('[data-testid="titlebar-preview-toggle"]').click();
  await page.locator('[data-testid="preview-section-files"]').waitFor({ timeout: 15_000 });

  /** 打开一个样本并等它的 viewer 真的渲染出内容。 */
  async function openFixture(fileName, viewerTestId, contentSelector) {
    await page.locator('[data-testid="preview-section-files"]').click();
    // 必须限定在预览侧栏内：左侧工作区面板复用同一个 FileTree 组件，
    // `data-testid="file-tree"` / `data-path` 在页面上各有一份，不限定会命中 2 个元素
    // （strict mode violation）。
    const row = page.locator(`[data-testid="preview-sider"] [data-path$="/${fileName}"] [data-testid="file-tree-row"]`);
    await row.waitFor({ timeout: 15_000 });
    await row.click();
    await page.locator(`[data-testid="${viewerTestId}"]`).waitFor({ timeout: 30_000 });
    if (contentSelector) {
      // 「没报错」不等于「渲染了」：pdf.js / Univer 在资源缺失时是静默降级，
      // 所以必须等到真实内容节点出现（被 CSP 拦下的抓取会另经违规闸兜住）。
      await page.locator(contentSelector).first().waitFor({ timeout: 30_000 });
    }
  }

  await openFixture("sample.md", "markdown-viewer");
  await page.getByText("服务端托管的 SPA 打开这个文件时").first().waitFor({ timeout: 20_000 });
  console.log("OK 3/5 markdown 渲染");

  await openFixture("sample.html", "html-viewer-frame");
  // srcdoc iframe 的内容不在主文档里，得进 frame 才能断言。
  await page.frameLocator('[data-testid="html-viewer-frame"]').getByText("HTML 预览样本").first().waitFor({ timeout: 20_000 });
  console.log("OK 4/5 html(srcdoc) 渲染");

  // pdf.js：worker + wasm 都要过 CSP；canvas 出现才算真渲染。
  await openFixture("sample.pdf", "pdf-viewer", '[data-testid="pdf-viewer"] canvas');

  // Univer：xlsx 的表格模式是 canvas 渲染。
  await openFixture("sample.xlsx", "sheet-viewer", '[data-testid="sheet-viewer"] canvas');
  console.log("OK 5/5 pdf(worker+wasm) 与 xlsx(Univer canvas) 渲染");

  /* ===== 3) 验收闸 ===== */
  const violations = await page.evaluate(() => window.__csp ?? []);
  if (violations.length > 0) {
    throw new Error(
      `CSP 违规 ${violations.length} 条：\n${violations
        .slice(0, 10)
        .map((v) => `  ${v.directive} ← ${v.blockedURI}${v.source ? ` (${v.source}:${v.line})` : ""}`)
        .join("\n")}`,
    );
  }
  if (failedRequests.length > 0) {
    throw new Error(
      `同源请求失败 ${failedRequests.length} 条：\n${failedRequests
        .slice(0, 10)
        .map((r) => `  ${r}`)
        .join("\n")}`,
    );
  }
  if (pageErrors.length > 0) {
    throw new Error(
      `页面未处理错误 ${pageErrors.length} 条：\n${pageErrors
        .slice(0, 5)
        .map((e) => `  ${e}`)
        .join("\n")}`,
    );
  }

  // console.error 只提示不拦：这条流程里本来就有**预期内**的噪音 ——
  // 登录前的 401（登录门就是靠它工作的）。agent 目录的同步报错曾是第二条，
  // 但写路径门（useCommandCapabilitiesStore）落地后服务端态不再尝试写库，
  // 再见到它就是回归信号，逐条确认时别放行。
  if (consoleErrors.length > 0) {
    console.warn(`console.error ${consoleErrors.length} 条（未阻断验收，逐条确认是否预期）：`);
    for (const e of consoleErrors.slice(0, 10)) console.warn("  ", e);
  }

  console.log("SERVED_SPA_OK: 托管产物零 CSP 违规，无同源请求失败，无页面错误");
} catch (err) {
  console.error("SERVED_SPA_FAIL:", err instanceof Error ? err.message : err);
  if (serverLog) {
    console.error("--- greywork-server 日志尾部 ---");
    console.error(serverLog.slice(-2000));
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (server) killServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  // 显式退出：整组杀是尽力而为，这里兜底，保证脚本不会因为残留管道句柄挂着不退。
  process.exit(process.exitCode ?? 0);
}
