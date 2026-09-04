/** 最小 HTTP 工具：统一「fetch JSON + 非 2xx 抛错」这一处处重复的样板。 */

/**
 * 取回 JSON，非 2xx 抛错。
 *
 * label 用于错误信息定位来源（如 "market source" / "MCP registry"），
 * 此前各调用方各自内联 `if (!response.ok) throw new Error(\`... HTTP ${status}\`)`，
 * 错误文案与判定逻辑重复且不一致。
 */
export async function fetchJson(url: string, label = "request", init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return response.json();
}
