/**
 * 插件安装态扫描：读取 `<dataDir>/plugins/<id>/plugin.json`。
 *
 * 远端插件市场（registry 拉取 / 包下载 / SHA-256 校验 / 安装 / 卸载）已下线；
 * 本模块只保留「列出已安装包」与插件 id 的目录键校验（plugin_fs / plugin_workspace 共用）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const MAX_PACKAGE_BYTES = 512 * 1024;
const MAX_CODE_BYTES = 1024 * 1024;

export interface PluginPackage {
  schemaVersion: 1;
  manifest: Record<string, unknown> & { id: string; name: string; version: string; kind?: string };
  code?: string;
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
