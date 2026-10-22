/**
 * 「手输路径」弹层（features/workspace/PathPromptDialog）：无原生选择器时唯一能填
 * 服务端路径的地方。Chromium 不实现 window.prompt，旧回退在自托管 Web 上点了毫无反应 ——
 * 这里守住替代实现的三条出口：确认（trim 后返回）、空白不可确认、取消返回 null。
 */
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import PathPromptDialog from "@/features/workspace/PathPromptDialog.vue";
import { pathPromptOpen, requestPathInput, settlePathInput } from "@/lib/path-prompt";

const mounted: VueWrapper[] = [];

/** 先起一个请求（模拟调用方 await），再挂弹层 —— 与外壳里 v-if 挂载的顺序一致。 */
async function render(): Promise<{ pending: Promise<string | null> }> {
  const pending = requestPathInput();
  const wrapper = mount(PathPromptDialog, { global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return { pending };
}

/** 弹层内容 Portal 到 body，wrapper.find 够不到。 */
function dialog(): DOMWrapper<Element> {
  const el = document.body.querySelector('[data-testid="path-prompt-dialog"]');
  if (!el) throw new Error("未渲染出路径输入弹层");
  return new DOMWrapper(el);
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
  // 兜底清掉可能残留的请求，避免串到下一个用例。
  settlePathInput(null);
});

describe("PathPromptDialog", () => {
  it("确认返回 trim 后的路径并收起弹层", async () => {
    const { pending } = await render();

    await dialog().find('[data-testid="path-prompt-input"]').setValue("  /srv/data/project  ");
    await dialog().find('[data-testid="path-prompt-confirm"]').trigger("click");

    await expect(pending).resolves.toBe("/srv/data/project");
    expect(pathPromptOpen.value).toBe(false);
  });

  it("空白输入：确认按钮置灰，点了也不收口", async () => {
    const { pending } = await render();
    const confirm = dialog().find('[data-testid="path-prompt-confirm"]');
    expect(confirm.attributes("disabled")).toBeDefined();

    await dialog().find('[data-testid="path-prompt-input"]').setValue("   ");
    expect(confirm.attributes("disabled")).toBeDefined();
    await confirm.trigger("click");
    expect(pathPromptOpen.value).toBe(true);

    // 收尾：别让这个请求悬着。
    await dialog().find('[data-testid="path-prompt-cancel"]').trigger("click");
    await expect(pending).resolves.toBeNull();
  });

  it("取消返回 null", async () => {
    const { pending } = await render();

    await dialog().find('[data-testid="path-prompt-cancel"]').trigger("click");

    await expect(pending).resolves.toBeNull();
    expect(pathPromptOpen.value).toBe(false);
  });
});
