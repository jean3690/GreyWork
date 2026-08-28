#!/usr/bin/env node
// CDP 驱动真实 Tauri 窗口（WebView2 / Chromium 运行态）：
//   连接 → 打开 ACP 弹层（触发自动连接后端）→ 等「模型/思考强度/会话模式」下拉出现 → 切模型 → 断言生效。
//
// 用法：
//   1) Windows 宿主：启动 app 前设置
//        set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
//      再启动 greywork.exe，然后运行：
//        pnpm --filter @greywork/desktop e2e:cdp
//   2) 本地无 Tauri 验证模式（纯 Chromium 加载 dist 产物，IPC 缺失自动降级为 UI 冒烟）：
//        pnpm --filter @greywork/desktop e2e:cdp --launch
//
// 可选环境变量：CDP_URL（默认 http://127.0.0.1:9222）、PAGE_URL_SUBSTR（多页面时按 URL 过滤）、
//               E2E_MODEL_SUBSTR（要切到的模型名子串，默认 "glm"）。
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const PAGE_URL_SUBSTR = process.env.PAGE_URL_SUBSTR ?? "";
const MODEL_SUBSTR = process.env.E2E_MODEL_SUBSTR ?? "glm";
const LAUNCH_MODE = process.argv.includes("--launch");
const PREVIEW_URL = process.env.PREVIEW_URL ?? "http://localhost:4173/";

function fail(message) {
  console.error(`[e2e:cdp] FAIL ${message}`);
  process.exit(1);
}

/** 找到目标页：优先按 URL 子串过滤，否则取第一个非 devtools 页。 */
async function resolvePage(browser) {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const pages = context.pages().filter((page) => !page.url().startsWith("devtools"));
  const target = pages.find((page) => page.url().includes(PAGE_URL_SUBSTR)) ?? pages[0];
  return target ?? (await context.newPage());
}

/**
 * 操作一个下拉：点 trigger → 从 portal 列表中选包含 substr 的项。
 * reka-ui Select 的 trigger 是 role=combobox 按钮，选项渲染在 body 级 portal 里。
 */
async function chooseOption(page, itemLocator, substr) {
  const trigger = itemLocator.locator('button[role="combobox"]').first();
  await trigger.click();
  const option = page.getByRole("option", { name: new RegExp(substr, "i") }).first();
  await option.waitFor({ state: "visible", timeout: 10_000 });
  const chosen = (await option.textContent())?.trim() ?? "";
  await option.click();
  return chosen;
}

let browser;
try {
  if (LAUNCH_MODE) {
    // 本地验证：自起 Chromium 开调试口并打开 dist 预览页，再走同一条 connectOverCDP 路径。
    const executablePath = chromium.executablePath();
    console.log(`[e2e:cdp] launch chromium ${executablePath} -> ${PREVIEW_URL}`);
    const child = spawn(
      executablePath,
      ["--headless=new", "--no-sandbox", "--remote-debugging-port=9222", "--user-data-dir=/tmp/greywork-e2e-profile", PREVIEW_URL],
      { stdio: "ignore" },
    );
    child.on("exit", () => console.log("[e2e:cdp] chromium exited"));
  }

  for (let attempt = 0; ; attempt++) {
    try {
      browser = await chromium.connectOverCDP(CDP_URL);
      break;
    } catch (error) {
      if (attempt >= 20) fail(`无法连接 CDP ${CDP_URL}: ${error.message}`);
      await sleep(500);
    }
  }
  console.log(`[e2e:cdp] connected ${CDP_URL}`);

  const page = await resolvePage(browser);
  console.log(`[e2e:cdp] page: ${page.url()}`);

  const hasTauri = await page.evaluate(() => typeof window === "object" && "__TAURI_INTERNALS__" in window);
  if (!hasTauri) {
    console.log("[e2e:cdp] 无 __TAURI_INTERNALS__：降级为 UI 冒烟（不驱动 IPC）");
  }

  // 打开 ACP 弹层 —— 打开动作本身触发 ChatView 的自动连接 watcher。
  const acpPill = page.locator('button[title*="ACP"]');
  await acpPill.waitFor({ timeout: 15_000 });
  await acpPill.click();

  const configGroup = page.locator(".acp-config");
  if (!hasTauri) {
    // 降级态：确认弹层结构存在即可收场。
    const switchRow = page.locator(".acp-pop .pop__row").first();
    await switchRow.waitFor({ timeout: 5_000 });
    console.log("[e2e:cdp] PASS degraded smoke（弹层结构可见，无 IPC 可驱动）");
  } else {
    // 连接 OpenCode：等 bar 上出现选择器组（session/new 返回 configOptions 后渲染）。
    await configGroup.waitFor({ state: "visible", timeout: 60_000 });
    const itemCount = await configGroup.locator(".acp-config__item").count();
    console.log(`[e2e:cdp] 会话配置就绪：${itemCount} 组下拉`);

    // 模型切换：选含 MODEL_SUBSTR 的项（避开当前值由断言兜底）。
    const modelItem = configGroup.locator(".acp-config__item", { hasText: "模型" }).first();
    const beforeModel = (await modelItem.locator('button[role="combobox"]').textContent())?.trim() ?? "";
    const pickedModel = await chooseOption(page, modelItem, MODEL_SUBSTR);
    if (!pickedModel) fail("模型下拉中没有匹配项");
    console.log(`[e2e:cdp] 模型切换请求已发出: ${beforeModel || "?"} -> ${pickedModel}`);

    // 思考强度：high/max 二值。
    const effortItem = configGroup.locator(".acp-config__item", { hasText: "思考强度" }).first();
    if ((await effortItem.count()) > 0) {
      const beforeEffort = (await effortItem.locator('button[role="combobox"]').textContent())?.trim() ?? "";
      const target = beforeEffort.toLowerCase() === "max" ? "high" : "max";
      const pickedEffort = await chooseOption(page, effortItem, target);
      console.log(`[e2e:cdp] 思考强度: ${beforeEffort || "?"} -> ${pickedEffort}`);
    }

    // 断言模型下拉当前显示已切换（reka-ui 会同步 SelectValue 文本）。
    await sleep(300);
    const afterModel = (await modelItem.locator('button[role="combobox"]').textContent())?.trim() ?? "";
    if (!afterModel.includes(pickedModel.split("/").pop() ?? "")) {
      fail(`模型未生效：期望含 ${pickedModel}，实际 ${afterModel}`);
    }
    console.log(`[e2e:cdp] PASS 模型当前值 = ${afterModel}`);
  }

  browser.close();
  console.log("[e2e:cdp] DONE");
  process.exit(0);
} catch (error) {
  fail(error?.stack ?? String(error));
}
