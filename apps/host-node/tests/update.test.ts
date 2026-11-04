import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkUpdate } from "../src/update.js";

const mock = createServer((request, response) => {
  if (request.url === "/no-release") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      tag_name: "v1.2.3",
      name: "",
      body: "notes",
      html_url: "https://example.com/release",
      published_at: "2026-01-01T00:00:00Z",
      prerelease: true,
    }),
  );
});

let origin = "";
const previous = process.env.GREYWORK_UPDATE_API;

beforeAll(async () => {
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  origin = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (previous === undefined) delete process.env.GREYWORK_UPDATE_API;
  else process.env.GREYWORK_UPDATE_API = previous;
  await new Promise<void>((resolve) => mock.close(() => resolve()));
});

describe("checkUpdate", () => {
  it("解析 tag / name 回落 / notes / prerelease", async () => {
    process.env.GREYWORK_UPDATE_API = origin;
    const release = await checkUpdate();
    expect(release).toEqual({
      version: "1.2.3",
      tag: "v1.2.3",
      name: "v1.2.3",
      notes: "notes",
      url: "https://example.com/release",
      publishedAt: "2026-01-01T00:00:00Z",
      prerelease: true,
    });
  });

  it("404 视为仓库尚无发布版本", async () => {
    process.env.GREYWORK_UPDATE_API = `${origin}/no-release`;
    await expect(checkUpdate()).rejects.toThrow("仓库尚无发布版本");
  });
});
