import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
const host = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@greywork/host-ipc", async (original) => ({ ...(await original()), hasHostCommands: () => true, invoke: host.invoke }));
import CloudUploadDialog from "../CloudUploadDialog.vue";
import { useUserAccountStore } from "@/stores/user-account";
import { i18n } from "@/i18n";
let wrapper: VueWrapper;
beforeEach(() => {
  setActivePinia(createPinia());
  host.invoke.mockReset();
  useUserAccountStore().session = {
    user: { id: "1", email: "u@test.local", displayName: null, role: "user" },
    device: { id: "2", name: "电脑", platform: "desktop" },
  };
});
afterEach(() => {
  wrapper?.unmount();
  document.body.innerHTML = "";
});
describe("云存储文件选择", () => {
  it("先选择文件再上传，目录不会被当成文件上传", async () => {
    host.invoke.mockImplementation(async (command: string) => {
      if (command === "fs_list_dir")
        return [
          { path: "/workspace/report.md", name: "report.md", kind: "file", size: 4 },
          { path: "/workspace/docs", name: "docs", kind: "directory", size: null },
        ];
      if (command === "cloud_upload_file") return { id: "9223372036854775806", name: "report.md", status: "ready" };
      throw new Error(command);
    });
    wrapper = mount(CloudUploadDialog, {
      props: { open: true, root: "/workspace", kind: "library" },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    const dialog = new DOMWrapper(document.body.querySelector('[data-testid="cloud-upload-dialog"]')!);
    expect(dialog.findAll('input[type="checkbox"]')).toHaveLength(1);
    expect(host.invoke).not.toHaveBeenCalledWith("cloud_upload_file", expect.anything());
    await dialog.get('input[type="checkbox"]').setValue(true);
    const upload = dialog.findAll("button").find((button) => button.text() === "上传文件")!;
    await upload.trigger("click");
    await flushPromises();
    expect(host.invoke).toHaveBeenCalledWith("cloud_upload_file", { path: "/workspace/report.md", kind: "library" });
    expect(wrapper.emitted("uploaded")).toHaveLength(1);
    expect(wrapper.emitted("update:open")).toContainEqual([false]);
  });
  it("上传失败保留选择并显示可重试错误，不虚报成功", async () => {
    host.invoke.mockImplementation(async (command: string) => {
      if (command === "fs_list_dir") return [{ path: "/workspace/f", name: "f", kind: "file", size: 1 }];
      throw new Error("RustFS 连接失败");
    });
    wrapper = mount(CloudUploadDialog, {
      props: { open: true, root: "/workspace", kind: "file" },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    await flushPromises();
    const dialog = new DOMWrapper(document.body.querySelector('[data-testid="cloud-upload-dialog"]')!);
    await dialog.get('input[type="checkbox"]').setValue(true);
    await dialog
      .findAll("button")
      .find((button) => button.text() === "上传文件")!
      .trigger("click");
    await flushPromises();
    expect(dialog.get('[role="alert"]').text()).toContain("RustFS 连接失败");
    expect((dialog.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.emitted("uploaded")).toBeUndefined();
  });
});
