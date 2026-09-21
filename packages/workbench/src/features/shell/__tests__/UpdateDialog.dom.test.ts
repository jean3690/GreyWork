// UpdateDialog 的状态契约：打开即查最新 Release，与当前版本比对后走三条分支
// —— 有更新（列出发布说明 + 前往下载）/ 已最新 / 检查失败（可重试）。
// 弹层 Portal 到 body，断言一律查 document.body。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import type * as UpdateBackendModule from "@/lib/update-backend";

const backend = vi.hoisted(() => ({
  currentVersion: vi.fn<() => Promise<string | null>>(),
  checkUpdate: vi.fn(),
  openExternal: vi.fn(() => Promise.resolve()),
}));

// 只替换真正打宿主的调用，保留真实的 isNewerVersion / REPO_URL —— 分支判定要走真逻辑。
vi.mock("@/lib/update-backend", async (orig) => {
  const actual = await orig<typeof UpdateBackendModule>();
  return { ...actual, updateBackend: backend };
});
import UpdateDialog from "@/features/shell/UpdateDialog.vue";
import { i18n } from "@/i18n";

const RELEASE = {
  version: "0.2.0",
  tag: "v0.2.0",
  name: "GreyWork 0.2.0",
  notes: "- 新增数据分析\n- 修复若干问题",
  url: "https://github.com/jean3690/GreyWork/releases/tag/v0.2.0",
  publishedAt: "2026-09-20T00:00:00Z",
  prerelease: false,
};

const mounted: VueWrapper[] = [];

async function mountDialog(): Promise<VueWrapper> {
  const wrapper = mount(UpdateDialog, { global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

function content(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>('[data-testid="update-dialog"]');
  if (!el) throw new Error("未渲染出 update-dialog");
  return el;
}

beforeEach(() => {
  backend.currentVersion.mockReset().mockResolvedValue("0.1.1");
  backend.checkUpdate.mockReset().mockResolvedValue(RELEASE);
  backend.openExternal.mockClear();
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("UpdateDialog", () => {
  it("有新版本：标注可更新、列出发布说明，点前往下载打开发布页并关闭", async () => {
    const wrapper = await mountDialog();

    expect(content().querySelector('[data-testid="update-available"]')).not.toBeNull();
    expect(content().querySelector('[data-testid="update-notes"]')?.textContent).toContain("数据分析");

    const download = content().querySelector<HTMLButtonElement>('[data-testid="update-download"]');
    expect(download).not.toBeNull();
    download!.click();
    await flushPromises();

    expect(backend.openExternal).toHaveBeenCalledWith(RELEASE.url);
    expect(wrapper.emitted("close")).toBeTruthy();
  });

  it("已是最新：不给下载按钮，显示已最新", async () => {
    backend.currentVersion.mockResolvedValue("0.2.0");
    await mountDialog();

    expect(content().querySelector('[data-testid="update-uptodate"]')).not.toBeNull();
    expect(content().querySelector('[data-testid="update-download"]')).toBeNull();
  });

  it("检查失败：显示错误并可重试，重试再查一次", async () => {
    backend.checkUpdate.mockRejectedValueOnce(new Error("网络炸了")).mockResolvedValueOnce(RELEASE);
    await mountDialog();

    expect(content().querySelector('[data-testid="update-error"]')?.textContent).toContain("网络炸了");

    content().querySelector<HTMLButtonElement>('[data-testid="update-retry"]')!.click();
    await flushPromises();

    expect(backend.checkUpdate).toHaveBeenCalledTimes(2);
    expect(content().querySelector('[data-testid="update-available"]')).not.toBeNull();
  });
});
