/** 公共目录不需要登录；地址跟随 Java 控制面，但绝不把账号 token 发给第三方源。 */
export const DEFAULT_JAVA_BACKEND_URL = "http://127.0.0.1:8080";

function trimUrl(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

export function javaBackendOrigin(configuredBaseUrl?: string | null): string {
  return trimUrl(configuredBaseUrl) || trimUrl(process.env.GREYWORK_CONTROL_URL) || DEFAULT_JAVA_BACKEND_URL;
}

/** 显式源 > 专用环境变量 > 当前 Java 后端；MCP 的 registry 根包含 /api/market/mcp。 */
export function marketOrigin(kind: "skills" | "mcp", override?: unknown, configuredBaseUrl?: string | null): string {
  const explicit = trimUrl(override);
  const env = trimUrl(process.env[kind === "skills" ? "GREYWORK_SKILLS_ORIGIN" : "GREYWORK_MCP_REGISTRY_URL"]);
  if (explicit || env) return explicit || env;
  const backend = javaBackendOrigin(configuredBaseUrl);
  return kind === "skills" ? backend : `${backend}/api/market/mcp`;
}
