import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import CloudTaskForm from "../CloudTaskForm.vue";
import { formatCloudTime } from "../task-draft";
import { useUserAccountStore } from "@/stores/user-account";

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
});
describe("云端任务编辑器", () => {
  it("保存时保留设备字符串 ID，并让用户选择离线跳过", async () => {
    const account = useUserAccountStore();
    account.session = {
      user: { id: "1", email: "u@test.local", displayName: null, role: "user" },
      device: { id: "9223372036854775806", name: "电脑", platform: "desktop" },
    };
    const wrapper = mount(CloudTaskForm, {
      props: { task: null, hosts: [{ deviceId: "9223372036854775806", name: "电脑", alive: true }], zone: "Asia/Shanghai", saving: false },
    });
    await wrapper.findAll("input")[0].setValue("日报");
    await wrapper.get("textarea").setValue("生成日报");
    await wrapper.findAll("select")[2].setValue("skip");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("save")?.[0]?.[0]).toMatchObject({
      hostDeviceId: "9223372036854775806",
      offlinePolicy: "skip",
      execution: "host",
      cronExpr: "0 9 * * *",
      onceAt: null,
    });
    wrapper.unmount();
  });
  it("非法 Cron 不允许保存；现有 ACP 任务不会被改写成模型直连", async () => {
    const wrapper = mount(CloudTaskForm, { props: { task: null, hosts: [], zone: "UTC", saving: false } });
    await wrapper.findAll("input")[0].setValue("日报");
    await wrapper.get("textarea").setValue("生成日报");
    await wrapper.findAll("input")[1].setValue("bad cron");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("save")).toBeUndefined();
    expect(wrapper.text()).toContain("请输入合法的五段 Cron");
    wrapper.unmount();
  });
  it("一次性任务按服务器时区呈现，而非按客户端时区猜测", () => {
    expect(formatCloudTime(Date.UTC(2026, 10, 19, 1, 0), "Asia/Shanghai")).toBe("2026-11-19T09:00");
    expect(formatCloudTime(Date.UTC(2026, 10, 19, 1, 0), "UTC")).toBe("2026-11-19T01:00");
  });
});
