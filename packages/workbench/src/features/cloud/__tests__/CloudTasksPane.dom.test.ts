import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia } from "pinia";
const actions = vi.hoisted(() => ({ save: vi.fn(), refresh: vi.fn() }));
vi.mock("../useCloudTasks", async () => {
  const { shallowRef } = await import("vue");
  return {
    useCloudTasks: () => ({
      tasks: shallowRef([]),
      runs: shallowRef([]),
      hosts: shallowRef([]),
      zone: shallowRef("UTC"),
      loading: shallowRef(false),
      saving: shallowRef(false),
      error: shallowRef(""),
      refresh: actions.refresh,
      save: actions.save,
      remove: vi.fn(),
      setEnabled: vi.fn(),
    }),
  };
});
import CloudTasksPane from "../CloudTasksPane.vue";
import CloudTaskForm from "../CloudTaskForm.vue";
import { pendingCloudTaskDraft, type CloudTaskDraft } from "../task-draft";
import type { CloudTask, CloudTaskInput } from "@/lib/cloud-api";
import { i18n } from "@/i18n";
const wrappers: VueWrapper[] = [];
beforeEach(() => {
  pendingCloudTaskDraft.value = null;
  actions.save.mockReset();
  actions.refresh.mockReset();
});
afterEach(() => {
  wrappers.forEach((wrapper) => wrapper.unmount());
  wrappers.length = 0;
  pendingCloudTaskDraft.value = null;
});
function pane() {
  const wrapper = mount(CloudTasksPane, { global: { plugins: [createPinia(), i18n] } });
  wrappers.push(wrapper);
  return wrapper;
}
function draft(name: string): CloudTaskDraft {
  return { name, intent: name, cron: "0 9 * * *", onceAt: null, onCreated: vi.fn() };
}
const input: CloudTaskInput = {
  name: "D1",
  intent: "D1",
  schedule: "0 9 * * *",
  cronExpr: "0 9 * * *",
  onceAt: null,
  acpProviderId: null,
  target: "model",
  execution: "host",
  hostDeviceId: null,
  model: null,
  enabled: true,
  offlinePolicy: "replay",
};

describe("任务提案提交归属", () => {
  it("D1 保存晚到只确认 D1，不标记或清空另一个页面的 D2", async () => {
    let finish!: (task: CloudTask) => void;
    actions.save.mockImplementation(
      () =>
        new Promise<CloudTask>((resolve) => {
          finish = resolve;
        }),
    );
    const d1 = draft("D1");
    pendingCloudTaskDraft.value = d1;
    const first = pane();
    first.getComponent(CloudTaskForm).vm.$emit("save", input);
    await flushPromises();
    first.unmount();
    const d2 = draft("D2");
    pendingCloudTaskDraft.value = d2;
    const second = pane();
    finish({ ...input, id: "at-server-D1", nextRunAt: null });
    await flushPromises();
    expect(d1.onCreated).toHaveBeenCalledWith("at-server-D1");
    expect(d2.onCreated).not.toHaveBeenCalled();
    expect(pendingCloudTaskDraft.value).toBe(d2);
    expect(second.getComponent(CloudTaskForm).props("draft")).toBe(d2);
  });
  it("同一页面收到新提案后旧提交结果不关闭新编辑器", async () => {
    let finish!: (task: CloudTask) => void;
    actions.save.mockImplementation(
      () =>
        new Promise<CloudTask>((resolve) => {
          finish = resolve;
        }),
    );
    const d1 = draft("D1");
    pendingCloudTaskDraft.value = d1;
    const wrapper = pane();
    wrapper.getComponent(CloudTaskForm).vm.$emit("save", input);
    await flushPromises();
    const d2 = draft("D2");
    pendingCloudTaskDraft.value = d2;
    await flushPromises();
    expect(wrapper.getComponent(CloudTaskForm).props("draft")).toBe(d2);
    finish({ ...input, id: "at-server-D1", nextRunAt: null });
    await flushPromises();
    expect(d2.onCreated).not.toHaveBeenCalled();
    expect(wrapper.getComponent(CloudTaskForm).props("draft")).toBe(d2);
    expect(pendingCloudTaskDraft.value).toBe(d2);
  });
});
