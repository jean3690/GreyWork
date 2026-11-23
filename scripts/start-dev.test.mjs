import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backendAddress,
  backendEnvironment,
  desktopEnvironment,
  javaAddressMatchesConfig,
  parseOptions,
  probeBackend,
  stopOwnedChild,
  waitForBackend,
} from "./start-dev.mjs";

test("启动选项严格校验，防止拼错跳过后端参数时仍启动服务", () => {
  assert.equal(parseOptions(["--no-backend", "--skip-build"]).noBackend, true);
  assert.equal(parseOptions(["--timeout", "300"]).timeoutMs, 300_000);
  assert.throws(() => parseOptions(["--no-backned"]));
  assert.throws(() => parseOptions(["--backend-url"]));
  assert.throws(() => parseOptions(["--timeout", "0"]));
});

test("Java env 文件仅读取、不执行、不覆盖，终端环境优先", () => {
  const directory = mkdtempSync(path.join(process.env.OPENCODE_SESSION_ID ? "/tmp/opencode" : tmpdir(), "greywork-startup-"));
  try {
    mkdirSync(path.join(directory, "back/grey"), { recursive: true });
    const file = path.join(directory, "back/grey/.env");
    const text = 'SERVER_PORT=9000\nGREY_MASTER_KEY="stored-key"\nGREY_ADMIN_PASSWORD="$(echo never-execute)"\n';
    writeFileSync(file, text);
    const env = backendEnvironment(directory, { SERVER_PORT: "9001" });
    assert.equal(env.SERVER_PORT, "9001");
    assert.equal(env.GREY_ADMIN_PASSWORD, "$(echo never-execute)");
    assert.equal(env.SPRING_DOCKER_COMPOSE_LIFECYCLE_MANAGEMENT, "start-only");
    assert.equal(readFileText(file), text);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

function readFileText(file) {
  return readFileSync(file, "utf8");
}

test("桌面端不继承 Java 的管理员/数据库/模型主密钥，但保留本机模型变量", () => {
  const env = desktopEnvironment(
    {
      GREY_MASTER_KEY: "private",
      GREY_ADMIN_PASSWORD: "private",
      SPRING_DATASOURCE_PASSWORD: "private",
      OPENAI_API_KEY: "local-key",
      GREYWORK_CONTROL_URL: "http://127.0.0.1:8080",
      GREYWORK_CONTROL_TOKEN: "explicit-account-token",
    },
    "http://127.0.0.1:8080",
  );
  assert.equal(env.GREY_MASTER_KEY, undefined);
  assert.equal(env.SPRING_DATASOURCE_PASSWORD, undefined);
  assert.equal(env.OPENAI_API_KEY, "local-key");
  assert.equal(env.GREYWORK_CONTROL_TOKEN, "explicit-account-token");
  assert.equal(env.GREYWORK_ELECTRON_DIST, "1");
  assert.equal(desktopEnvironment({ GREYWORK_CONTROL_TOKEN: "unpaired" }, "https://new.test").GREYWORK_CONTROL_TOKEN, undefined);
  assert.equal(
    desktopEnvironment({ GREYWORK_CONTROL_URL: "https://old.test", GREYWORK_CONTROL_TOKEN: "old-token" }, "https://new.test")
      .GREYWORK_CONTROL_TOKEN,
    undefined,
  );
});

test("地址从端口/上下文配置生成，拒绝携带 URL 凭据的地址", () => {
  assert.equal(backendAddress({ SERVER_PORT: "9000", SERVER_SERVLET_CONTEXT_PATH: "/grey" }), "http://127.0.0.1:9000/grey");
  assert.throws(() => backendAddress({ SERVER_PORT: "99999" }));
  assert.throws(() => backendAddress({}, "http://user:secret@java.test"));
  assert.throws(() => backendAddress({}, "https://java.test?token=secret"));
  assert.equal(javaAddressMatchesConfig({}, "http://localhost:8080"), true);
  assert.equal(javaAddressMatchesConfig({}, "http://localhost:9000"), false);
  assert.equal(javaAddressMatchesConfig({ SERVER_SERVLET_CONTEXT_PATH: "/grey" }, "http://localhost:8080/grey"), true);
});

test("后端必须同时有健康状态和 GreyWork 目录，不接受任意占端口服务", async () => {
  const replies = [Response.json({ status: "UP" }), Response.json([])];
  assert.equal(await probeBackend("http://java.test", { fetchImpl: async () => replies.shift() }), "ready");
  assert.equal(await probeBackend("http://foreign.test", { fetchImpl: async () => Response.json({ unrelated: true }) }), "foreign");
});

test("就绪等待可取消，遇到其他服务不重试或杀进程", async () => {
  let attempts = 0;
  await waitForBackend("http://java.test", { intervalMs: 1, probe: async () => (++attempts === 1 ? "starting" : "ready") });
  assert.equal(attempts, 2);
  await assert.rejects(waitForBackend("http://foreign.test", { probe: async () => "foreign" }));
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(waitForBackend("http://java.test", { signal: controller.signal }), /stop/);
});

test("清理只操作传入的新建进程组，已退出进程不再操作旧 PID", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  await once(child, "spawn");
  await stopOwnedChild(child, 1000);
  assert.notEqual(child.signalCode, null);
  await stopOwnedChild(child, 1000);
});

test("仅检查已有后端的 CLI 不启动其他服务，也不会关闭已有后端", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/actuator/health" ? { status: "UP" } : []));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}`;
    const script = fileURLToPath(new URL("./start-dev.mjs", import.meta.url));
    const child = spawn(process.execPath, [script, "--backend-only", "--no-backend", "--backend-url", url], {
      env: { ...process.env, SERVER_PORT: "8080" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (value) => {
      output += value;
    });
    child.stderr.on("data", (value) => {
      output += value;
    });
    const [code] = await once(child, "close");
    assert.equal(code, 0, output);
    assert.match(output, /复用已有后端/);
    assert.equal(server.listening, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
