/**
 * 检查更新：拉 GitHub 最新 Release 给前端展示（应用没有内置 updater，「更新」= 看说明 + 去下载）。
 *
 * 与 `services/update.rs` 同契约：GitHub API 必须带 User-Agent（否则 403），404 视为
 * 「仓库尚无发布版本」，tag 去掉前导 v 作为语义化版本。`GREYWORK_UPDATE_API` 仅用于测试时
 * 指向本地 mock（默认值就是真实端点，运行时行为不变）。
 */
const REPO_URL = "https://github.com/jean3690/GreyWork";
const LATEST_RELEASE_API = "https://api.github.com/repos/jean3690/GreyWork/releases/latest";

export interface LatestRelease {
  version: string;
  tag: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string;
  prerelease: boolean;
}

export async function checkUpdate(): Promise<LatestRelease> {
  const endpoint = process.env.GREYWORK_UPDATE_API ?? LATEST_RELEASE_API;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: {
        "user-agent": "GreyWork-Updater",
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`检查更新请求失败: ${(error as Error).message}`, { cause: error });
  }
  if (response.status === 404) throw new Error("仓库尚无发布版本");
  if (!response.ok) throw new Error(`检查更新返回状态 ${response.status}`);
  const body = (await response.json().catch((error: unknown) => {
    throw new Error(`解析发布信息失败: ${(error as Error).message}`, { cause: error });
  })) as {
    tag_name?: unknown;
    name?: unknown;
    body?: unknown;
    html_url?: unknown;
    published_at?: unknown;
    prerelease?: unknown;
  };
  const tag = typeof body.tag_name === "string" ? body.tag_name : "";
  if (tag === "") throw new Error("发布信息缺少版本号");
  const version = tag.replace(/^[vV]/, "");
  return {
    version,
    tag,
    name: typeof body.name === "string" && body.name !== "" ? body.name : tag,
    notes: typeof body.body === "string" ? body.body : "",
    url: typeof body.html_url === "string" && body.html_url !== "" ? body.html_url : REPO_URL,
    publishedAt: typeof body.published_at === "string" ? body.published_at : "",
    prerelease: body.prerelease === true,
  };
}
