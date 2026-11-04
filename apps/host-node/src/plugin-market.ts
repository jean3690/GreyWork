/**
 * 插件市场：registry 拉取 / 安装 / 列举 / 卸载。
 * 移植 `services/plugin_market/` 的核心语义（registry fetch、SHA-256 校验、
 * 身份一致性检查、两阶段落盘）。
 *
 * `plugin_market_preview` 与 `plugin_market_install` 共用 fetch_and_validate；
 * `plugin_net_fetch` 等运行期能力属运行时面，不在本模块。
 *
 * `GREYWORK_PLUGIN_REGISTRY_URL` 缺省为官方 registry；测试可覆盖。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_REGISTRY_BYTES = 512 * 1024;
const MAX_PACKAGE_BYTES = 512 * 1024;
const MAX_CODE_BYTES = 1024 * 1024;

interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  downloadUrl: string;
  sha256: string;
}

export interface PluginRegistry {
  schemaVersion: 1;
  plugins: RegistryEntry[];
}

export interface PluginPackage {
  schemaVersion: 1;
  manifest: Record<string, unknown> & { id: string; name: string; version: string; kind?: string };
  code?: string;
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function validateKey(raw: string, label: string): void {
  const valid = raw !== "" && raw.length <= 96 && /^[a-z0-9]/.test(raw) && /^[a-z0-9._:-]*$/.test(raw);
  if (!valid) throw new Error(`invalid ${label}: ${JSON.stringify(raw)}`);
}

export function validateDirKey(raw: string, label: string): void {
  validateKey(raw, label);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(raw) || raw.endsWith(".") || raw.endsWith(" ")) {
    throw new Error(`invalid ${label}: ${JSON.stringify(raw)}`);
  }
}

function validatePackageShape(pkg: PluginPackage): void {
  if (pkg.schemaVersion !== 1) {
    throw new Error(`unsupported package schema version: ${pkg.schemaVersion}`);
  }
  const m = pkg.manifest;
  if (typeof m.id !== "string" || m.id === "") throw new Error("manifest.id is required");
  if (typeof m.name !== "string" || m.name === "") throw new Error("manifest.name is required");
  if (typeof m.version !== "string" || m.version === "") throw new Error("manifest.version is required");
}

export function pluginsRoot(dataDir: string): string {
  return path.join(dataDir, "plugins");
}

async function fetchText(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
  return buffer;
}

export async function fetchCatalog(registryUrl: string): Promise<PluginRegistry> {
  const bytes = await fetchText(registryUrl, MAX_REGISTRY_BYTES);
  const registry = JSON.parse(bytes.toString("utf8")) as PluginRegistry;
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.plugins)) {
    throw new Error("invalid plugin registry JSON");
  }
  return registry;
}

async function fetchAndValidatePackage(registryUrl: string, pluginId: string): Promise<PluginPackage> {
  validateKey(pluginId, "plugin id");
  const registry = await fetchCatalog(registryUrl);
  const entry = registry.plugins.find((item) => item.id === pluginId);
  if (!entry) throw new Error(`plugin not found in registry: ${pluginId}`);
  const packageBytes = await fetchText(entry.downloadUrl, MAX_PACKAGE_BYTES);
  const actualHash = sha256Hex(packageBytes);
  if (actualHash !== entry.sha256) {
    throw new Error(`plugin checksum mismatch: expected ${entry.sha256}, got ${actualHash}`);
  }
  const pkg = JSON.parse(packageBytes.toString("utf8")) as PluginPackage;
  validatePackageShape(pkg);
  if (pkg.manifest.id !== entry.id || pkg.manifest.version !== entry.version) {
    throw new Error("plugin package identity does not match registry entry");
  }
  const runtime = pkg.manifest?.runtime as { entry?: string; sha256?: string } | undefined;
  if (runtime?.entry && typeof runtime.sha256 === "string") {
    const codeBytes = await fetchText(runtime.entry, MAX_CODE_BYTES);
    const codeHash = sha256Hex(codeBytes);
    if (codeHash !== runtime.sha256) {
      throw new Error(`plugin code checksum mismatch: expected ${runtime.sha256}, got ${codeHash}`);
    }
    pkg.code = codeBytes.toString("utf8");
  }
  return pkg;
}

export async function marketPreview(registryUrl: string, pluginId: string): Promise<unknown> {
  const pkg = await fetchAndValidatePackage(registryUrl, pluginId);
  return pkg.manifest;
}

export function installPackageAt(root: string, pkg: PluginPackage): string {
  validatePackageShape(pkg);
  const target = path.join(root, pkg.manifest.id);
  mkdirSync(target, { recursive: true });
  const finalPath = path.join(target, "plugin.json");
  const tempPath = path.join(target, "plugin.json.tmp");
  writeFileSync(tempPath, JSON.stringify(pkg, null, 2));
  renameSync(tempPath, finalPath);
  return finalPath;
}

export async function marketInstall(
  host: { dataDir: string },
  registryUrl: string,
  pluginId: string,
): Promise<{ id: string; version: string; path: string }> {
  const pkg = await fetchAndValidatePackage(registryUrl, pluginId);
  const root = pluginsRoot(host.dataDir);
  const finalPath = installPackageAt(root, pkg);
  return { id: pkg.manifest.id, version: pkg.manifest.version, path: finalPath };
}

export function listInstalledAt(root: string): PluginPackage[] {
  if (!existsSync(root)) return [];
  const packages: PluginPackage[] = [];
  for (const name of readdirSync(root)) {
    const dir = path.join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const bytes = readFileSync(path.join(dir, "plugin.json"));
      if (bytes.length > MAX_PACKAGE_BYTES + MAX_CODE_BYTES) continue;
      const pkg = JSON.parse(bytes.toString("utf8")) as PluginPackage;
      if (pkg.schemaVersion === 1 && pkg.manifest?.id === name) packages.push(pkg);
    } catch {
      continue;
    }
  }
  packages.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  return packages;
}

export function marketUninstall(dataDir: string, pluginId: string): void {
  validateDirKey(pluginId, "plugin id");
  const target = path.join(pluginsRoot(dataDir), pluginId);
  if (!existsSync(target)) throw new Error(`plugin not installed: ${pluginId}`);
  rmSync(target, { recursive: true });
}
