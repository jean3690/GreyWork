import type { ControlPlaneRuntime } from "./control-plane.js";
import type { WorkspaceAccess } from "./workspace-access.js";
import path from "node:path";

/** 凭据只由控制面运行时注入。禁止将此命令变成任意 URL/管理接口的代理。 */
export function validateCloudRequest(method: string, pathname: string): void {
  const url = new URL(pathname, "http://cloud.invalid");
  if (url.origin !== "http://cloud.invalid" || url.pathname.includes("%") || pathname.includes("\\") || url.pathname.includes("..")) {
    throw new Error("无效的云端接口路径");
  }
  const routes: Record<string, RegExp[]> = {
    GET: [
      /^\/api\/storage\/(config|objects(?:\/[1-9]\d{0,18}(?:\/download)?)?)$/,
      /^\/api\/automation\/tasks(?:\/(config|runs))?$/,
      /^\/api\/hosts$/,
      /^\/api\/skills$/,
      /^\/api\/download\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_-]+$/,
    ],
    POST: [
      /^\/api\/storage\/uploads$/,
      /^\/api\/storage\/objects\/[1-9]\d{0,18}\/complete$/,
      /^\/api\/automation\/tasks$/,
      /^\/api\/automation\/tasks\/at-[a-zA-Z0-9-]+\/(enable|disable)$/,
    ],
    PUT: [/^\/api\/automation\/tasks\/at-[a-zA-Z0-9-]+$/],
    DELETE: [/^\/api\/storage\/objects\/[1-9]\d{0,18}$/, /^\/api\/automation\/tasks\/at-[a-zA-Z0-9-]+$/],
  };
  if (!routes[method]?.some((route) => route.test(url.pathname))) throw new Error("不允许访问该云端接口");
  if ([...url.searchParams.keys()].some((key) => !["kind", "limit", "taskId", "q"].includes(key))) throw new Error("无效的查询参数");
}

export async function uploadWorkspaceFile(
  runtime: ControlPlaneRuntime,
  access: WorkspaceAccess,
  raw: string,
  kind: string,
): Promise<unknown> {
  if (!["file", "library"].includes(kind)) throw new Error("无效的存储分类");
  return runtime.withCloudConnection(async (connection) => {
    const config = (await connection.request("GET", "/api/storage/config")) as {
      enabled: boolean;
      maxObjectBytes: number;
      reason?: string;
    };
    if (!config.enabled) throw new Error(config.reason || "服务器尚未启用对象存储");
    // 不经渲染端搬运字节；复用宿主授权读面，硬顶 128MiB 防止内存耗尽。
    const bytes = access.readMedia(raw, Math.min(config.maxObjectBytes, 128 * 1024 * 1024));
    const ticket = (await connection.request("POST", "/api/storage/uploads", {
      name: path.basename(raw),
      contentType: "application/octet-stream",
      sizeBytes: bytes.length,
      visibility: "private",
      kind,
    })) as { id: string; uploadUrl: string; contentType: string };
    try {
      const url = new URL(ticket.uploadUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("服务器返回了无效的上传地址");
      const response = await fetch(url, {
        method: "PUT",
        headers: { "content-type": ticket.contentType, "content-length": String(bytes.length) },
        body: new Uint8Array(bytes),
        signal: AbortSignal.any([connection.signal, AbortSignal.timeout(300_000)]),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`文件上传失败：HTTP ${response.status}`);
      return await connection.request("POST", `/api/storage/objects/${ticket.id}/complete`);
    } catch (error) {
      // 失败的上传单及时清理；不能用清理错误掩盖原始错误。
      await connection.cleanupUpload(ticket.id).catch(() => {});
      throw error;
    }
  });
}
