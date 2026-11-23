/** Java 内置真实样例经 HTTP 下载：技能落盘、npm tgz 获取、MCP 握手和工具调用。无需数据库/公网。 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatch, type CommandContext } from "../src/commands.js";
import { skillsInstall, type SkillSnapshotFile } from "../src/skills.js";
import { mcpCall, mcpProbe, mcpSearch } from "../src/mcp.js";

const resources = fileURLToPath(new URL("../../../back/grey/src/main/resources/", import.meta.url));
const skills = (
  JSON.parse(readFileSync(path.join(resources, "catalog/skills.json"), "utf8")) as {
    skills: { ref: string; skillId: string; name: string; files: SkillSnapshotFile[] }[];
  }
).skills.filter((skill) => skill.ref.startsWith("greywork/tests/"));
const servers = (
  JSON.parse(readFileSync(path.join(resources, "catalog/mcp.json"), "utf8")) as {
    servers: { name: string; title: string; packages: { identifier: string; registryType: string }[] }[];
  }
).servers.filter((server) => server.name.startsWith("io.greywork.demo/"));
const packagePaths = new Set(servers.map((server) => server.packages[0].identifier));
const downloaded = new Set<string>();
const directory = mkdtempSync(path.join(process.env.OPENCODE_SESSION_ID ? "/tmp/opencode" : tmpdir(), "greywork-market-fixtures-"));
const cache = path.join(directory, "npm-cache");
const workspace = path.join(directory, "workspace");
mkdirSync(workspace);
let base = "";
const http = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://test.invalid");
  if (url.pathname === "/api/skills") {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        skills.map((skill) => ({
          ref: skill.ref,
          skill_id: skill.skillId,
          name: skill.name,
          installs: 0,
          source: "greywork",
          downloadable: true,
        })),
      ),
    );
  } else if (url.pathname.startsWith("/api/download/")) {
    const skill = skills.find((item) => url.pathname === `/api/download/${item.ref}`);
    if (!skill) return void response.writeHead(404).end();
    const hash = createHash("sha256");
    for (const file of skill.files) hash.update(file.path).update("\0").update(file.contents).update("\0");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ files: skill.files, hash: hash.digest("hex") }));
  } else if (url.pathname === "/api/market/mcp/v0/servers") {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        servers: servers.map((server) => ({
          server: { ...server, packages: server.packages.map((pkg) => ({ ...pkg, identifier: base + pkg.identifier })) },
        })),
      }),
    );
  } else if (packagePaths.has(url.pathname)) {
    downloaded.add(url.pathname);
    response.setHeader("content-type", "application/octet-stream");
    response.end(readFileSync(path.join(resources, "static", url.pathname)));
  } else {
    response.writeHead(404).end();
  }
});
const ctx = { trustedHost: true, controlPlane: { status: () => ({ baseUrl: base }) } } as unknown as CommandContext;

beforeAll(async () => {
  vi.stubEnv("GREYWORK_SKILLS_ORIGIN", "");
  vi.stubEnv("GREYWORK_MCP_REGISTRY_URL", "");
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
  vi.unstubAllEnvs();
  // 仅清理由本测试新建的目录，不接触真实用户工作区/npm 缓存。
  rmSync(directory, { recursive: true });
});

function launch(identifier: string) {
  return {
    transport: "stdio",
    command: "npx",
    args: ["--cache", cache, "-y", identifier],
    env: { npm_config_audit: "false", npm_config_fund: "false", npm_config_registry: `${base}/unused-registry` },
  };
}

describe("真实下载测试样例", () => {
  it("三个技能下载后完整安装，嵌套参考文件与中文内容保持一致", async () => {
    const results = await dispatch("skills_search", { query: "demo" }, ctx);
    expect(results).toMatchObject({
      kind: "json",
      value: expect.arrayContaining(skills.map((skill) => expect.objectContaining({ ref: skill.ref, origin: base }))),
    });
    for (const skill of skills) {
      const snapshot = await dispatch("skills_download", { entryRef: skill.ref }, ctx);
      if (snapshot.kind !== "json") throw new Error("expected JSON snapshot");
      const payload = snapshot.value as { files: SkillSnapshotFile[]; hash: string; origin: string };
      expect(payload.origin).toBe(base);
      expect(payload.hash).toMatch(/^[a-f0-9]{64}$/);
      const report = skillsInstall(workspace, skill.skillId, payload.files);
      expect(report.filesWritten).toBe(skill.files.length);
      for (const file of skill.files) expect(readFileSync(path.join(report.dir, file.path), "utf8")).toBe(file.contents);
    }
  });

  it("从 HTTP 真正下载回显 MCP 的 tgz，npx 启动并握手/回显中文", async () => {
    const entry = (await mcpSearch("demo", 10, `${base}/api/market/mcp`)).find((server) => server.name.endsWith("/echo"))!;
    const request = launch(entry.packages[0].identifier);
    const report = await mcpProbe(request);
    expect(report.serverName).toBe("greywork-demo-echo");
    expect(report.tools.map((tool) => tool.name)).toEqual(["demo_echo"]);
    const call = await mcpCall({ ...request, tool: "demo_echo", arguments: { text: "你好 Java" } });
    expect(call).toMatchObject({ text: "你好 Java", isError: false });
    expect(downloaded.has("/api/market/mcp/packages/greywork-demo-echo-0.1.0.tgz")).toBe(true);
  }, 30_000);

  it("下载计算 MCP 的 tgz，正常计算并返回可见的参数错误", async () => {
    const request = launch(`${base}/api/market/mcp/packages/greywork-demo-math-0.1.0.tgz`);
    expect((await mcpProbe(request)).tools.map((tool) => tool.name)).toEqual(["demo_add", "demo_multiply"]);
    expect(await mcpCall({ ...request, tool: "demo_add", arguments: { a: 2, b: 3 } })).toMatchObject({ text: "5", isError: false });
    expect(await mcpCall({ ...request, tool: "demo_multiply", arguments: { a: 6, b: 7 } })).toMatchObject({ text: "42", isError: false });
    expect(await mcpCall({ ...request, tool: "demo_add", arguments: { a: "bad", b: 1 } })).toMatchObject({ isError: true });
    expect(await mcpCall({ ...request, tool: "not_a_tool", arguments: {} })).toMatchObject({ isError: true });
    expect(downloaded.has("/api/market/mcp/packages/greywork-demo-math-0.1.0.tgz")).toBe(true);
  }, 30_000);
});
