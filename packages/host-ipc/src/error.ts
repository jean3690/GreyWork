/** 服务端同源 API 前缀。服务端不发 CORS 头、cookie 也必须同源，所以只能是相对路径。 */

export const API_BASE = "/api";

/**
 * 解析服务端的错误信封 —— 恒为 `{"error": string}`。
 *
 * 非 JSON 响应体（代理错误页、网关超时页）与缺字段时退回调用方给的兜底文案，
 * 不能让「解析错误体失败」把原始状态码也吞掉。
 */
export async function errorMessageFrom(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object") {
      const message = (body as { error?: unknown }).error;
      if (typeof message === "string" && message) return message;
    }
  } catch {
    // 落到兜底文案。
  }
  return fallback;
}
