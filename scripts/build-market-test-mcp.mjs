/** 把零依赖测试 MCP 打成 npm tgz；包随 Java jar 发布，不需发布到 npm。 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "back/grey/src/main/resources/catalog/test-mcp");
const destination = path.join(root, "back/grey/src/main/resources/static/api/market/mcp/packages");
const tempRoot = process.env.OPENCODE_SESSION_ID ? "/tmp/opencode" : process.env.TMPDIR || "/tmp";
mkdirSync(destination, { recursive: true });
for (const profile of ["echo", "math"]) {
  const staging = mkdtempSync(path.join(tempRoot, `greywork-mcp-${profile}-`));
  try {
    copyFileSync(path.join(source, profile, "package.json"), path.join(staging, "package.json"));
    copyFileSync(path.join(source, "server.mjs"), path.join(staging, "server.mjs"));
    chmodSync(path.join(staging, "server.mjs"), 0o755);
    const [{ filename, integrity }] = JSON.parse(
      execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], { cwd: staging, encoding: "utf8" }),
    );
    const manifest = JSON.parse(readFileSync(path.join(staging, "package.json"), "utf8"));
    console.log(`${manifest.name}: /api/market/mcp/packages/${filename} (${integrity})`);
  } finally {
    // 只删除本次打包新建的临时目录。
    rmSync(staging, { recursive: true });
  }
}
