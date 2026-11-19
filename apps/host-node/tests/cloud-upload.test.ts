import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadWorkspaceFile } from "../src/cloud.js";
import { ControlPlaneRuntime } from "../src/control-plane.js";
import { Db } from "../src/db.js";
import { WorkspaceAccess } from "../src/workspace-access.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length) await cleanups.pop()?.();
});
async function serve(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return `http://127.0.0.1:${address.port}`;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("上传会话归属", () => {
  it.each(["switch", "disconnect", "unchanged"])("PUT 期间 %s 保持原票据的会话归属", async (action) => {
    vi.stubEnv("GREYWORK_CONTROL_URL", "");
    vi.stubEnv("GREYWORK_CONTROL_TOKEN", "");
    const dataDir = mkdtempSync("/tmp/opencode/gw-upload-session-");
    const filename = path.join(dataDir, "report.txt");
    writeFileSync(filename, "original bytes");
    const db = new Db(path.join(dataDir, "test.db"));
    cleanups.push(() => db.close());
    const runtime = new ControlPlaneRuntime({ dataDir, version: "test", db, tickSecs: 3600 });
    cleanups.push(() => runtime.stop());
    const access = new WorkspaceAccess(dataDir, path.join(dataDir, "access.json"));
    const started = deferred();
    let putClosed = false;
    let releasePut!: () => void;
    const storage = createServer((request, response) => {
      request.resume();
      response.on("close", () => {
        putClosed = true;
      });
      releasePut = () => {
        if (!response.destroyed) response.writeHead(200).end();
      };
      started.resolve();
    });
    const uploadOrigin = await serve(storage);
    const calls: Array<{ account: string; method: string; url: string }> = [];
    const control = createServer((request, response) => {
      const account = request.headers.authorization === "Bearer fixture-A" ? "A" : "B";
      const url = request.url ?? "";
      calls.push({ account, method: request.method ?? "", url });
      request.resume();
      response.setHeader("content-type", "application/json");
      if (url === "/api/storage/config") response.end(JSON.stringify({ enabled: true, maxObjectBytes: 1024 }));
      else if (url === "/api/storage/uploads")
        response.end(JSON.stringify({ id: "101", uploadUrl: `${uploadOrigin}/object`, contentType: "application/octet-stream" }));
      else if (url.includes("/objects/") && account === "B") response.writeHead(404).end(JSON.stringify({ code: "object_not_found" }));
      else if (url === "/api/storage/objects/101/complete") response.end(JSON.stringify({ id: "101", status: "ready" }));
      else response.end("{}");
    });
    const origin = await serve(control);
    await runtime.configure({ baseUrl: origin, token: "fixture-A" });
    const uploading = uploadWorkspaceFile(runtime, access, filename, "file");
    const outcome = uploading.then(
      () => "success",
      () => "cancelled",
    );
    await started.promise;
    if (action === "switch") await runtime.configure({ baseUrl: origin, token: "fixture-B" });
    else if (action === "disconnect") runtime.clear();
    if (action !== "unchanged") await vi.waitFor(() => expect(putClosed).toBe(true));
    releasePut();
    expect(await outcome).toBe(action === "unchanged" ? "success" : "cancelled");
    expect(calls.filter((call) => call.url.includes("/objects/"))).toEqual([
      {
        account: "A",
        method: action === "unchanged" ? "POST" : "DELETE",
        url: `/api/storage/objects/101${action === "unchanged" ? "/complete" : ""}`,
      },
    ]);
  });
});
