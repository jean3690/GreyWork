// UpdateDialog 状态契约：打开即 check()，按 mode 走三条分支 ——
// auto（应用内下载安装 + 重启）/ manual（打开发布页）/ unsupported（浏览器态）；
// 检查失败可重试。弹层 Portal 到 body，断言查 document.body。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";

const backend = vi.hoisted(() => ({
  check: vi.fn(),
  downloadAndInstall: vi.fn(() => Promise.resolve()),
  relaunchApp: vi.fn(() => Promise.resolve()),
  openExternal: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/update-backend", () => ({ updateBackend: backend }));

import UpdateDialog from "@/features/shell/UpdateDialog.vue";
import { i18n } from "@/i18n";

const AUTO_UPDATE = {
  mode: "auto" as const,
  hasUpdate: true,
  version: "0.2.0",
  currentVersion: "0.1.1",
  notes: "- 新增数据分析\n- 修复若干问题",
  date: "2026-09-20",
  url: "https://github.com/jean3690/GreyWork/releases/tag/v0.2.0",
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
  backend.check.mockReset().mockResolvedValue(AUTO_UPDATE);
  backend.downloadAndInstall.mockReset().mockResolvedValue(undefined);
  backend.relaunchApp.mockClear();
  backend.openExternal.mockClear();
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("UpdateDialog", () => {
  it("auto：列发布说明，点安装→下载安装→装完给重启键，点重启调 relaunch", async () => {
    await mountDialog();

    expect(content().querySelector('[data-testid="update-available"]')).not.toBeNull();
    expect(content().querySelector('[data-testid="update-notes"]')?.textContent).toContain("数据分析");

    content().querySelector<HTMLButtonElement>('[data-testid="update-install"]')!.click();
    await flushPromises();

    expect(backend.downloadAndInstall).toHaveBeenCalledTimes(1);
    const restart = content().querySelector<HTMLButtonElement>('[data-testid="update-restart"]');
    expect(restart).not.toBeNull();
    restart!.click();
    await flushPromises();
    expect(backend.relaunchApp).toHaveBeenCalledTimes(1);
  });

  it("manual：给「前往下载」，点击打开发布页并关闭", async () => {
    backend.check.mockResolvedValue({ ...AUTO_UPDATE, mode: "manual" });
    const wrapper = await mountDialog();

    // manual 不给应用内安装键
    expect(content().querySelector('[data-testid="update-install"]')).toBeNull();
    const download = content().querySelector<HTMLButtonElement>('[data-testid="update-download"]');
    expect(download).not.toBeNull();
    download!.click();
    await flushPromises();

    expect(backend.openExternal).toHaveBeenCalledWith(AUTO_UPDATE.url);
    expect(wrapper.emitted("close")).toBeTruthy();
  });

  it("已是最新：不给安装/下载键，显示已最新", async () => {
    backend.check.mockResolvedValue({
      mode: "auto",
      hasUpdate: false,
      version: "0.2.0",
      currentVersion: "0.2.0",
      notes: "",
      date: "",
      url: "",
    });
    await mountDialog();

    expect(content().querySelector('[data-testid="update-uptodate"]')).not.toBeNull();
    expect(content().querySelector('[data-testid="update-install"]')).toBeNull();
    expect(content().querySelector('[data-testid="update-download"]')).toBeNull();
  });

  it("unsupported（浏览器态）：提示需要桌面版", async () => {
    backend.check.mockResolvedValue({
      mode: "unsupported",
      hasUpdate: false,
      version: null,
      currentVersion: null,
      notes: "",
      date: "",
      url: "",
    });
    await mountDialog();

    expect(content().querySelector('[data-testid="update-unsupported"]')).not.toBeNull();
  });

  it("检查失败：显示错误并可重试，重试再查一次", async () => {
    backend.check.mockRejectedValueOnce(new Error("网络炸了")).mockResolvedValueOnce(AUTO_UPDATE);
    await mountDialog();

    expect(content().querySelector('[data-testid="update-error"]')?.textContent).toContain("网络炸了");

    content().querySelector<HTMLButtonElement>('[data-testid="update-retry"]')!.click();
    await flushPromises();

    expect(backend.check).toHaveBeenCalledTimes(2);
    expect(content().querySelector('[data-testid="update-available"]')).not.toBeNull();
  });
});
