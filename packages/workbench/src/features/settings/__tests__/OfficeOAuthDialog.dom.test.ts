/**
 * 扫码授权弹窗的可观察行为。
 *
 * 这里守的是「用户真能走完一次授权」这条链路：打开授权页 → 粘贴回调 URL → 完成授权 → 徽标
 * 变「已授权」；以及两类必须如实暴露的失败（state 不一致、配置不全）与退出登录。
 * 宿主命令一律 mock（`office_oauth_*` 的语义由 Rust 侧用例覆盖）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { OfficeProviderConfig } from "@greywork/shell";

vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal()),
  invoke: vi.fn(),
}));
vi.mock("@/lib/browser-backend", () => ({ openInSystemBrowser: vi.fn() }));

import OfficeOAuthDialog from "@/features/settings/OfficeOAuthDialog.vue";

const invokeMock = vi.mocked((await import("@greywork/host-ipc")).invoke);
const openMock = vi.mocked((await import("@/lib/browser-backend")).openInSystemBrowser);

const mounted: VueWrapper[] = [];

function provider(oauth?: OfficeProviderConfig["oauth"]): OfficeProviderConfig {
  return { id: "tencent-docs", name: "腾讯文档", family: "office", kind: "tencent-docs", enabled: true, ...(oauth ? { oauth } : {}) };
}

const CONFIGURED = { clientId: "cid-1", redirectUri: "https://localhost/callback" };

/** 弹窗内容 Portal 到 body，wrapper.find 够不到 —— 直接查 body。 */
function body(): HTMLElement {
  const el = document.body.querySelector('[data-slot="dialog-content"]');
  if (!el) throw new Error("未渲染出 dialog-content");
  return el as HTMLElement;
}

function mountDialog(entry: OfficeProviderConfig, open = true): VueWrapper {
  const wrapper = mount(OfficeOAuthDialog, { props: { open, provider: entry }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  invokeMock.mockReset();
  openMock.mockReset();
  invokeMock.mockRejectedValue(new Error("本用例未提供宿主命令"));
  (window as unknown as Record<string, unknown>).__GREYWORK_RUNTIME__ = "server";
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
  delete (window as unknown as Record<string, unknown>).__GREYWORK_RUNTIME__;
});

describe("OfficeOAuthDialog", () => {
  it("配置不全：提示先编辑，不给授权按钮", async () => {
    mountDialog(provider());
    await flushPromises();

    expect(body().querySelector('[data-testid="office-oauth-need-config"]')).not.toBeNull();
    expect(body().querySelector('[data-testid="office-oauth-open"]')).toBeNull();
  });

  it("打开授权页 → 粘贴回调 → 完成授权：徽标变已授权并显示 userId", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "office_oauth_begin")
        return Promise.resolve({ authorizeUrl: "https://docs.qq.com/oauth/v2/authorize?x=1", state: "st-1" });
      if (command === "office_oauth_submit")
        return Promise.resolve({ authorized: true, expired: false, userId: "u-9", expiresAt: 1893456000000 });
      return Promise.reject(new Error("unexpected"));
    });
    mountDialog(provider(CONFIGURED));
    await flushPromises();

    (body().querySelector('[data-testid="office-oauth-open"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(openMock).toHaveBeenCalledWith("https://docs.qq.com/oauth/v2/authorize?x=1");

    const input = body().querySelector('[data-testid="office-oauth-callback"]') as HTMLInputElement;
    input.value = "https://localhost/callback?code=abc&state=st-1";
    input.dispatchEvent(new Event("input"));
    await flushPromises();

    (body().querySelector('[data-testid="office-oauth-submit"]') as HTMLButtonElement).click();
    await flushPromises();

    // state 由弹窗保管，提交时原样回传。
    expect(invokeMock).toHaveBeenCalledWith("office_oauth_submit", expect.objectContaining({ expectedState: "st-1" }));
    expect(body().querySelector('[data-testid="office-oauth-status"]')?.textContent).toContain("已授权");
    expect(body().querySelector('[data-testid="office-oauth-user-id"]')?.textContent).toContain("u-9");
  });

  it("state 不一致：原样显示宿主报错，徽标不变成已授权", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "office_oauth_submit") return Promise.reject(new Error("回调 state 与本次授权不一致，请重新发起授权"));
      return Promise.reject(new Error("unexpected"));
    });
    mountDialog(provider(CONFIGURED));
    await flushPromises();

    const input = body().querySelector('[data-testid="office-oauth-callback"]') as HTMLInputElement;
    input.value = "https://localhost/callback?code=abc&state=wrong";
    input.dispatchEvent(new Event("input"));
    await flushPromises();
    (body().querySelector('[data-testid="office-oauth-submit"]') as HTMLButtonElement).click();
    await flushPromises();

    expect(body().querySelector('[data-testid="office-oauth-error"]')?.textContent).toContain("state");
    expect(body().querySelector('[data-testid="office-oauth-status"]')?.textContent).toContain("授权未知");
  });

  it("打开时拉一次状态：已授权的 provider 直接显示已授权", async () => {
    invokeMock.mockResolvedValue({ authorized: true, expired: false, userId: "u-1" });
    const wrapper = mountDialog(provider(CONFIGURED), false);
    await wrapper.setProps({ open: true });
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith("office_oauth_status", { clientId: "cid-1" });
    expect(body().querySelector('[data-testid="office-oauth-status"]')?.textContent).toContain("已授权");
  });

  it("退出登录：调用 logout 并把徽标置为未授权", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "office_oauth_status") return Promise.resolve({ authorized: true, expired: false });
      if (command === "office_oauth_logout") return Promise.resolve(null);
      return Promise.reject(new Error("unexpected"));
    });
    const wrapper = mountDialog(provider(CONFIGURED), false);
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(body().querySelector('[data-testid="office-oauth-status"]')?.textContent).toContain("已授权");

    (body().querySelector('[data-testid="office-oauth-logout"]') as HTMLButtonElement).click();
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith("office_oauth_logout", { clientId: "cid-1" });
    expect(body().querySelector('[data-testid="office-oauth-status"]')?.textContent).toContain("未授权");
  });

  it("浏览器预览态：没有宿主命令，动作按钮报「不可用」而不是静默", async () => {
    (window as unknown as Record<string, unknown>).__GREYWORK_RUNTIME__ = "browser-preview";
    mountDialog(provider(CONFIGURED));
    await flushPromises();

    (body().querySelector('[data-testid="office-oauth-open"]') as HTMLButtonElement).click();
    await flushPromises();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(body().querySelector('[data-testid="office-oauth-error"]')?.textContent).toContain("浏览器预览态");
  });
});
